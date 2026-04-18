import { Hono } from "hono";
import { stat } from "node:fs/promises";
import {
  AuthStorage,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  createAgentSession,
  createCodingTools,
  type AgentSessionEvent,
} from "@mariozechner/pi-coding-agent";
import { buildSystemPrompt, buildUserPrompt } from "../../agent/prompts";
import { scheduleCheckpoint } from "../checkpoint";
import {
  getWorkspace,
  isValidWorkspaceId,
  refreshDocumentSnapshots,
  setTurnState,
} from "../workspace";

export const chatRouter = new Hono();

// Tracks in-flight agent sessions per workspace so we can cancel them.
// Only one turn per workspace at a time — later /turn calls while one is
// active will 409 so the UI can show a clear error.
interface ActiveTurn {
  abort: () => Promise<void>;
}
const activeTurns = new Map<string, ActiveTurn>();

// Model registry + auth are process-singleton. AuthStorage falls back to
// `process.env.ANTHROPIC_API_KEY` (wired via pi-ai's getEnvApiKey) so doppler
// injects the key without extra plumbing.
let sharedAuth: AuthStorage | null = null;
let sharedRegistry: ModelRegistry | null = null;
function getSharedAuth(): AuthStorage {
  if (!sharedAuth) sharedAuth = AuthStorage.inMemory();
  return sharedAuth;
}
function getSharedRegistry(): ModelRegistry {
  if (!sharedRegistry) sharedRegistry = ModelRegistry.create(getSharedAuth());
  return sharedRegistry;
}

function resolveAnthropicModel(): ReturnType<ModelRegistry["find"]> {
  const registry = getSharedRegistry();
  // Match the same default the original useAgent used. Users who want a
  // different model should override in settings later.
  const model = registry.find("anthropic", "claude-sonnet-4-5");
  if (!model) {
    const available = registry
      .getAvailable()
      .map((m) => `${m.provider}/${m.id}`)
      .join(", ");
    throw new Error(
      `anthropic/claude-sonnet-4-5 not in registry. Available: ${available}`,
    );
  }
  return model;
}

// ---------------------------------------------------------------------------
// POST /api/chat/turn — SSE stream of AgentSessionEvents
// Body: { workspaceId: string, userText: string }
// ---------------------------------------------------------------------------
chatRouter.post("/turn", async (c) => {
  let body: { workspaceId?: unknown; userText?: unknown };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ ok: false, error: "invalid JSON body" }, 400);
  }
  const { workspaceId, userText } = body;
  if (typeof workspaceId !== "string" || !isValidWorkspaceId(workspaceId)) {
    return c.json({ ok: false, error: "invalid workspaceId" }, 400);
  }
  if (typeof userText !== "string" || userText.trim().length === 0) {
    return c.json({ ok: false, error: "userText required" }, 400);
  }
  const workspace = await getWorkspace(workspaceId);
  if (!workspace) {
    return c.json({ ok: false, error: "unknown workspace" }, 404);
  }
  if (activeTurns.has(workspaceId)) {
    return c.json({ ok: false, error: "turn already in progress" }, 409);
  }

  const encoder = new TextEncoder();
  let closed = false;
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;

  const write = (chunk: string): boolean => {
    if (closed || !controllerRef) return false;
    try {
      controllerRef.enqueue(encoder.encode(chunk));
      return true;
    } catch {
      closed = true;
      return false;
    }
  };
  const send = (kind: string, payload: unknown) => {
    write(`event: ${kind}\ndata: ${JSON.stringify(payload)}\n\n`);
  };

  // Track working.docx mtime/size so we can fire a checkpoint when a tool
  // call actually changes the on-disk doc. Lightweight replacement for
  // fs.watch which was racy against our own save-back writes.
  let lastStat: { mtimeMs: number; size: number } | null = null;
  try {
    const s = await stat(workspace.workingPath);
    lastStat = { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    lastStat = null;
  }
  const maybeFireCheckpoint = async (sourceTool: string) => {
    try {
      const s = await stat(workspace.workingPath);
      const changed =
        !lastStat ||
        s.mtimeMs !== lastStat.mtimeMs ||
        s.size !== lastStat.size;
      if (changed) {
        lastStat = { mtimeMs: s.mtimeMs, size: s.size };
        scheduleCheckpoint(workspace.id, sourceTool);
        // Also refresh document_text.current.json + document_structure.current.json
        // so the agent's next `read` of those files returns live content,
        // without it having to run `./docx-tool refresh`.
        refreshDocumentSnapshots(workspace).catch((err) => {
          console.warn(
            `[chat] snapshot refresh failed for ${workspace.id}:`,
            (err as Error).message,
          );
        });
      }
    } catch {
      // working.docx missing is fatal elsewhere — ignore here.
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controllerRef = controller;
      write(": connected\n\n");

      setTurnState(workspace.id, true);

      let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | null =
        null;
      let unsubscribe: (() => void) | null = null;

      const cleanup = () => {
        if (unsubscribe) {
          try { unsubscribe(); } catch { /* ignore */ }
          unsubscribe = null;
        }
        if (session) {
          try { session.dispose(); } catch { /* ignore */ }
          session = null;
        }
        setTurnState(workspace.id, false);
        activeTurns.delete(workspace.id);
        if (!closed) {
          closed = true;
          try { controller.close(); } catch { /* already closed */ }
        }
      };

      activeTurns.set(workspace.id, {
        abort: async () => {
          if (session) {
            try { await session.abort(); } catch { /* ignore */ }
          }
        },
      });

      try {
        const model = resolveAnthropicModel();
        const settingsManager = SettingsManager.inMemory({
          compaction: { enabled: true },
          retry: { enabled: true, maxRetries: 3 },
        });
        const resourceLoader = new DefaultResourceLoader({
          cwd: workspace.dir,
          settingsManager,
          systemPromptOverride: () => buildSystemPrompt(),
        });
        await resourceLoader.reload();

        const created = await createAgentSession({
          cwd: workspace.dir,
          model,
          thinkingLevel: "medium",
          authStorage: getSharedAuth(),
          modelRegistry: getSharedRegistry(),
          tools: createCodingTools(workspace.dir),
          resourceLoader,
          sessionManager: SessionManager.inMemory(),
          settingsManager,
        });
        session = created.session;

        // Refresh snapshots once before the agent sees them so the first
        // `read document_text.current.json` is never served a stale placeholder.
        await refreshDocumentSnapshots(workspace).catch(() => undefined);

        unsubscribe = session.subscribe((event: AgentSessionEvent) => {
          // Forward every event to the browser with the same `type` string
          // the client's chat rendering already expects.
          send(event.type, event);
          // Auto-refresh working.docx snapshot whenever a tool call finished.
          if (event.type === "tool_execution_end") {
            void maybeFireCheckpoint(`tool:${event.toolName}`);
          }
        });

        await session.prompt(buildUserPrompt(userText));
        // One final check in case the last write beat the stat poll.
        await maybeFireCheckpoint("turn-end");
        send("done", { ok: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        send("error", { message });
      } finally {
        cleanup();
      }
    },
    cancel() {
      // Browser disconnected — abort the session if it's still running.
      const turn = activeTurns.get(workspace.id);
      if (turn) {
        void turn.abort();
      }
      closed = true;
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "X-Workspace-Id": workspace.id,
    },
  });
});

// ---------------------------------------------------------------------------
// POST /api/chat/cancel — abort the in-flight turn for a workspace
// Body: { workspaceId: string }
// ---------------------------------------------------------------------------
chatRouter.post("/cancel", async (c) => {
  let body: { workspaceId?: unknown };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ ok: false, error: "invalid JSON body" }, 400);
  }
  const { workspaceId } = body;
  if (typeof workspaceId !== "string" || !isValidWorkspaceId(workspaceId)) {
    return c.json({ ok: false, error: "invalid workspaceId" }, 400);
  }
  const turn = activeTurns.get(workspaceId);
  if (!turn) return c.json({ ok: true, wasActive: false });
  await turn.abort();
  return c.json({ ok: true, wasActive: true });
});
