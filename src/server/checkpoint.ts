import { watch, type FSWatcher } from "node:fs";
import { writeFile } from "node:fs/promises";
import { closeSession, openSession, saveDocument } from "./headless-word";
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
    let bytes: Buffer | null = null;
    try {
      const session = await openSession(workspace.workingPath);
      try {
        bytes = await saveDocument(session);
      } finally {
        await closeSession(session);
      }
    } catch (err) {
      // headless-word failure: fall back to the on-disk working.docx as-is.
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `[checkpoint] headless-word unavailable for workspace=${workspace.id}, using raw working.docx:`,
        message,
      );
      publish(workspace.id, {
        kind: "error",
        message: `Checkpoint normalization skipped: ${message}`,
      });
      bytes = null;
    }

    if (bytes) {
      // Suppress our own fs-watch tick so the write-back doesn't re-enqueue us.
      state.suppressNextWatchUntil = Date.now() + 1500;
      await writeFile(workspace.workingPath, bytes);
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
