import type { WorkspaceEvent } from "../lib/types";

type Subscriber = (event: WorkspaceEvent) => void;

// In-memory per-workspace subscriber registry. Fine for our single-process
// Bun server. If we ever go multi-process we'll need a proper bus.
const subscribers = new Map<string, Set<Subscriber>>();

export function subscribe(
  workspaceId: string,
  send: Subscriber,
): () => void {
  let set = subscribers.get(workspaceId);
  if (!set) {
    set = new Set();
    subscribers.set(workspaceId, set);
  }
  set.add(send);
  return () => {
    const current = subscribers.get(workspaceId);
    if (!current) return;
    current.delete(send);
    if (current.size === 0) {
      subscribers.delete(workspaceId);
    }
  };
}

export function publish(workspaceId: string, event: WorkspaceEvent): void {
  const set = subscribers.get(workspaceId);
  if (!set || set.size === 0) return;
  // Copy to avoid mutation during iteration.
  for (const send of Array.from(set)) {
    try {
      send(event);
    } catch (err) {
      console.error(
        `[sse] subscriber for workspace=${workspaceId} threw:`,
        err,
      );
    }
  }
}

export function subscriberCount(workspaceId: string): number {
  return subscribers.get(workspaceId)?.size ?? 0;
}
