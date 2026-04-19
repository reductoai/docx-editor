import { watch, type FSWatcher } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  closeSession,
  listSessions,
  openSession,
  saveDocument,
  saveSessionInPlace,
} from "./headless-word";
import { extractSemanticContent, sanitizeDocxFile } from "./ooxml-sanitize";
import { publish } from "./sse";
import { getWorkspace, type Workspace } from "./workspace";
import { appendActivity } from "./activity";

export const DEBOUNCE_MS = 1200;
export const MIN_INTERVAL_MS = 4000;

interface CheckpointState {
  workspace: Workspace;
  seq: number;
  lastFiredAt: number;
  pendingTimer: ReturnType<typeof setTimeout> | null;
  pendingSourceTool?: string;
  inFlight: boolean;
  queued: boolean;
  watcher?: FSWatcher;
  suppressNextWatchUntil: number;
  /** SHA-256 of the post-save DOCX's normalized `word/document.xml`
   *  (rsid attrs stripped, LibreOffice round-trip artifacts stripped)
   *  at the last published checkpoint. Comparing against this lets us
   *  detect real content changes while ignoring the rsid churn
   *  LibreOffice produces on every save. Missing that normalization is
   *  what made an earlier gate over-publish on every idle read, and
   *  hashing just `getDocumentText()` instead missed mutations inside
   *  table cells — a normalized document.xml hash catches both. */
  lastSemanticHash: string | null;
}

const states = new Map<string, CheckpointState>();

function getOrCreate(workspace: Workspace): CheckpointState {
  const existing = states.get(workspace.id);
  if (existing) return existing;
  const state: CheckpointState = {
    workspace,
    seq: 0,
    lastFiredAt: 0,
    pendingTimer: null,
    inFlight: false,
    queued: false,
    suppressNextWatchUntil: 0,
    lastSemanticHash: null,
  };
  states.set(workspace.id, state);
  startFsWatcher(state);
  return state;
}

function startFsWatcher(state: CheckpointState) {
  try {
    state.watcher = watch(
      state.workspace.workingPath,
      { persistent: false },
      (eventType) => {
        if (eventType !== "change" && eventType !== "rename") return;
        // Suppress self-triggered writes from our own checkpoint write-back.
        if (Date.now() < state.suppressNextWatchUntil) return;
        scheduleCheckpoint(state.workspace.id, "fs-watch");
      },
    );
    state.watcher.on("error", (err) => {
      console.warn(
        `[checkpoint] watcher error for workspace=${state.workspace.id}:`,
        err.message,
      );
    });
  } catch (err) {
    // watch() can fail if the file doesn't exist yet; skip silently.
    console.warn(
      `[checkpoint] failed to start watcher for workspace=${state.workspace.id}:`,
      (err as Error).message,
    );
  }
}

export function getCurrentSeq(workspaceId: string): number {
  return states.get(workspaceId)?.seq ?? 0;
}

async function fire(state: CheckpointState): Promise<void> {
  if (state.inFlight) {
    state.queued = true;
    return;
  }
  state.inFlight = true;

  const sourceTool = state.pendingSourceTool;
  state.pendingSourceTool = undefined;

  try {
    const { workspace } = state;
    try {
      // CRITICAL: the agent is mutating an in-memory headless-word session
      // whose id lives in `headless_word_session.json`. We MUST save that
      // session in-place (no --path) so (a) the edits hit working.docx and
      // (b) the session remains valid for subsequent agent calls. A fresh
      // open() would serialize the stale on-disk DOCX and wipe the agent's
      // edits from the checkpoint.
      state.suppressNextWatchUntil = Date.now() + 1500;
      const sharedSessionId = await readSharedSessionId(workspace);

      // Always save + sanitize. The gate that decides whether to
      // publish is computed AFTER this, on the normalized post-save
      // contents, so rsid churn from an idempotent save doesn't
      // translate into a spurious browser refresh. We can't reliably
      // predict "did the session change?" up front because
      // `get-document-text` doesn't include table content, so a cell
      // edit slips past that kind of pre-save check.
      if (sharedSessionId) {
        await saveSessionInPlace(sharedSessionId);
      } else {
        const session = await openSession(workspace.workingPath);
        try {
          const bytes = await saveDocument(session);
          await writeFile(workspace.workingPath, bytes);
        } finally {
          await closeSession(session);
        }
      }
      // Strip LibreOffice round-trip artifacts (numPr w:numId=0, etc.)
      // that make `@eigenpal/docx-js-editor` mis-render Title paragraphs.
      // See src/server/ooxml-sanitize.ts.
      await sanitizeDocxFile(workspace.workingPath).catch((err) => {
        console.warn(
          `[checkpoint] sanitize failed for ${workspace.id}:`,
          (err as Error).message,
        );
      });

      // Semantic-content gate: hash the post-save `word/document.xml`
      // with rsid attrs stripped. Real mutations change the hash; a
      // pure idempotent save (rsid-only diff) does not. Skip the
      // publish if the hash hasn't moved since our last broadcast.
      const semantic = await extractSemanticContent(workspace.workingPath);
      const currentHash = createHash("sha256").update(semantic).digest("hex");
      if (currentHash === state.lastSemanticHash) {
        return; // `finally` runs cleanup; seq is NOT bumped.
      }
      state.lastSemanticHash = currentHash;
    } catch (err) {
      // headless-word failure: leave working.docx as-is and surface the
      // error on the SSE stream so the UI can flag it.
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `[checkpoint] headless-word save failed for workspace=${workspace.id}:`,
        message,
      );
      publish(workspace.id, {
        kind: "error",
        message: `Checkpoint save failed: ${message}`,
      });
    }

    state.seq += 1;
    state.lastFiredAt = Date.now();

    const event = {
      kind: "checkpoint" as const,
      seq: state.seq,
      docxUrl: `/api/workspaces/${workspace.id}/doc?seq=${state.seq}`,
      ...(sourceTool ? { sourceTool } : {}),
    };
    publish(workspace.id, event);
    await appendActivity(workspace.id, {
      type: "checkpoint",
      seq: state.seq,
      sourceTool,
    }).catch((err) => {
      console.warn(
        `[checkpoint] activity append failed for workspace=${workspace.id}:`,
        err.message,
      );
    });
  } finally {
    state.inFlight = false;
    if (state.queued) {
      state.queued = false;
      // Schedule another fire shortly — gives time for any trailing writes.
      setTimeout(() => {
        void fire(state);
      }, DEBOUNCE_MS);
    }
  }
}

export function scheduleCheckpoint(
  workspaceId: string,
  sourceTool?: string,
): void {
  // Resolve workspace lazily so the first call creates state.
  void (async () => {
    let state = states.get(workspaceId);
    if (!state) {
      const ws = await getWorkspace(workspaceId);
      // Re-check after the await in case a concurrent call won the race and
      // already registered a state (+ fs.watch). Otherwise we'd double-start.
      state = states.get(workspaceId) ?? (ws ? getOrCreate(ws) : undefined);
    }
    if (!state) return;
    const resolved = state;

    if (sourceTool) {
      resolved.pendingSourceTool = sourceTool;
    }

    if (resolved.pendingTimer) {
      clearTimeout(resolved.pendingTimer);
      resolved.pendingTimer = null;
    }

    const elapsed = Date.now() - resolved.lastFiredAt;
    const delay =
      elapsed >= MIN_INTERVAL_MS
        ? DEBOUNCE_MS
        : Math.max(DEBOUNCE_MS, MIN_INTERVAL_MS - elapsed);

    resolved.pendingTimer = setTimeout(() => {
      resolved.pendingTimer = null;
      void fire(resolved);
    }, delay);
  })();
}

/**
 * Ensures the checkpoint state + fs.watch exists for a workspace without
 * firing a checkpoint. Called by the workspace route right after creation.
 */
export async function ensureCheckpointState(workspaceId: string): Promise<void> {
  if (states.has(workspaceId)) return;
  const ws = await getWorkspace(workspaceId);
  if (!ws) return;
  // Re-check after the await: another concurrent call may have already set up
  // the state while we were resolving the workspace. Prevents double fs.watch.
  if (states.has(workspaceId)) return;
  getOrCreate(ws);
}

/**
 * Closes the fs.watch handle for a workspace and removes its checkpoint state.
 * Safe to call on unknown workspaces — it no-ops.
 *
 * TODO: no caller currently wires this up; hook it into workspace-delete /
 * process-shutdown once there's a natural place for it.
 */
/**
 * Reads the shared headless-word session id this workspace registered in
 * `ensureHeadlessSession`. Returns null if the file is missing, the id is
 * shaped like our workspace id (a stale placeholder from an earlier seeding),
 * or headless-word no longer knows about the session.
 */
async function readSharedSessionId(workspace: Workspace): Promise<string | null> {
  try {
    const raw = await readFile(
      path.join(workspace.dir, "headless_word_session.json"),
      "utf-8",
    );
    const parsed = JSON.parse(raw) as { session_id?: unknown };
    if (typeof parsed.session_id !== "string" || !parsed.session_id.trim()) {
      return null;
    }
    const id = parsed.session_id.trim();
    // Reject stale placeholders (we used to write the workspace id here).
    if (id === workspace.id) return null;
    const sessions = await listSessions();
    if (!sessions[id]) return null;
    return id;
  } catch {
    return null;
  }
}

export function teardownWorkspace(workspaceId: string): void {
  const state = states.get(workspaceId);
  if (!state) return;
  if (state.pendingTimer) {
    clearTimeout(state.pendingTimer);
    state.pendingTimer = null;
  }
  if (state.watcher) {
    try {
      state.watcher.close();
    } catch (err) {
      console.warn(
        `[checkpoint] error closing watcher for workspace=${workspaceId}:`,
        (err as Error).message,
      );
    }
    state.watcher = undefined;
  }
  states.delete(workspaceId);
}
