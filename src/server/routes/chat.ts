import { Hono } from "hono";
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
import { DEFAULT_MODEL_ID, isValidModelId } from "../../lib/models";
import { scheduleCheckpoint } from "../checkpoint";
import {
  HEADLESS_WORD_SKILL,
  README_AGENT,
  getWorkspace,
  isValidWorkspaceId,
  loadCurrentDocumentText,
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

function resolveAnthropicModel(
  modelId: string,
): ReturnType<ModelRegistry["find"]> {
  const registry = getSharedRegistry();
  const model = registry.find("anthropic", modelId);
  if (!model) {
    const available = registry
      .getAvailable()
      .map((m) => `${m.provider}/${m.id}`)
      .join(", ");
    throw new Error(
      `anthropic/${modelId} not in registry. Available: ${available}`,
    );
  }
  return model;
}

// ---------------------------------------------------------------------------
// POST /api/chat/turn — SSE stream of AgentSessionEvents
// Body: { workspaceId: string, userText: string }
// ---------------------------------------------------------------------------
chatRouter.post("/turn", async (c) => {
  let body: { workspaceId?: unknown; userText?: unknown; model?: unknown };
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
  const modelId = isValidModelId(body.model) ? body.model : DEFAULT_MODEL_ID;
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

  // After every tool call we unconditionally schedule a checkpoint. The
  // live edits live in the headless-word session (in memory) — nothing hits
  // `working.docx` on disk until `fire()` calls `saveSessionInPlace`. So a
  // "did the file change?" check is circular.
  //
  // `scheduleCheckpoint` is already debounced (MIN_INTERVAL_MS gap between
  // fires) and coalesces rapid tool calls into a single save+publish. If
  // the agent ran a read-only tool the checkpoint still fires, but the
  // resulting doc bytes are byte-identical to the last seq — cheap for the
  // browser to re-apply.
  const fireCheckpointForTool = (sourceTool: string) => {
    scheduleCheckpoint(workspace.id, sourceTool);
    // Refresh text/structure snapshots so the agent's next `read` of
    // document_text.current.json / document_structure.current.json sees
    // live content instead of the seeded stale placeholder.
    refreshDocumentSnapshots(workspace).catch((err) => {
      console.warn(
        `[chat] snapshot refresh failed for ${workspace.id}:`,
        (err as Error).message,
      );
    });
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
        const model = resolveAnthropicModel(modelId);

        // Refresh doc snapshots BEFORE building the system prompt so the
        // inlined document text reflects current state, not whatever
        // placeholder was seeded at workspace creation.
        await refreshDocumentSnapshots(workspace).catch(() => undefined);
        const documentText = await loadCurrentDocumentText(workspace);

        const settingsManager = SettingsManager.inMemory({
          compaction: { enabled: true },
          retry: { enabled: true, maxRetries: 3 },
        });
        const resourceLoader = new DefaultResourceLoader({
          cwd: workspace.dir,
          settingsManager,
          systemPromptOverride: () =>
            buildSystemPrompt({
              readmeAgent: README_AGENT,
              headlessWordSkill: HEADLESS_WORD_SKILL,
              documentText,
            }),
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

        unsubscribe = session.subscribe((event: AgentSessionEvent) => {
          // Forward every event to the browser with the same `type` string
          // the client's chat rendering already expects.
          send(event.type, event);
          // Schedule a checkpoint after every tool call so the browser
          // gets a live preview of the agent's edits.
          if (event.type === "tool_execution_end") {
            fireCheckpointForTool(`tool:${event.toolName}`);
          }
        });

        await session.prompt(buildUserPrompt(userText));
        // Belt-and-suspenders: fire one more checkpoint at turn end in case
        // the last tool-call's debounce window hadn't flushed yet.
        fireCheckpointForTool("turn-end");
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
// POST /api/chat/test/schedule-checkpoint — replay-test escape hatch
// Body: { workspaceId: string, sourceTool?: string }
//
// Lets `scripts/replay-trace.ts` (and other non-LLM tests) trigger the same
// checkpoint machinery the real agent loop invokes on every tool_execution_end.
// Only wired up in dev; never called from the browser.
// ---------------------------------------------------------------------------
chatRouter.post("/test/schedule-checkpoint", async (c) => {
  let body: { workspaceId?: unknown; sourceTool?: unknown };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ ok: false, error: "invalid JSON body" }, 400);
  }
  const { workspaceId, sourceTool } = body;
  if (typeof workspaceId !== "string" || !isValidWorkspaceId(workspaceId)) {
    return c.json({ ok: false, error: "invalid workspaceId" }, 400);
  }
  const workspace = await getWorkspace(workspaceId);
  if (!workspace) return c.json({ ok: false, error: "unknown workspace" }, 404);
  const tag = typeof sourceTool === "string" && sourceTool ? sourceTool : "test";
  scheduleCheckpoint(workspace.id, tag);
  return c.json({ ok: true, sourceTool: tag });
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
