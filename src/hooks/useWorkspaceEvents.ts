import { useEffect, useRef, useState } from "react";
import type { WorkspaceEvent } from "../lib/types";

export interface WorkspaceEventHandlers {
  onCheckpoint?: (p: {
    seq: number;
    docxUrl: string;
    sourceTool?: string;
  }) => void;
  onStatus?: (message: string) => void;
  onError?: (message: string) => void;
}

interface Result {
  connected: boolean;
}

const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 15_000;

/**
 * Subscribes to `/api/workspaces/<id>/events` via EventSource and invokes
 * the supplied handlers for each parsed `WorkspaceEvent`.
 *
 * - Handlers are held in a ref so the effect does NOT re-run (and reconnect)
 *   when the caller passes fresh closures each render.
 * - Reconnects with exponential backoff when the browser closes the source
 *   (e.g. server restart, transient network error).
 * - Tears down cleanly on unmount or workspaceId change.
 */
export function useWorkspaceEvents(
  workspaceId: string | null,
  handlers: WorkspaceEventHandlers,
): Result {
  const handlersRef = useRef<WorkspaceEventHandlers>(handlers);
  const [connected, setConnected] = useState(false);

  // Keep the handler ref fresh without forcing a reconnect.
  useEffect(() => {
    handlersRef.current = handlers;
  }, [handlers]);

  useEffect(() => {
    if (!workspaceId) {
      setConnected(false);
      return undefined;
    }

    let cancelled = false;
    let es: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let backoff = INITIAL_BACKOFF_MS;

    const parseAndDispatch = (ev: MessageEvent<string>) => {
      if (!ev.data) return;
      let payload: unknown;
      try {
        payload = JSON.parse(ev.data);
      } catch (err) {
        console.warn("[useWorkspaceEvents] failed to parse event data:", err);
        return;
      }
      const event = payload as WorkspaceEvent;
      const h = handlersRef.current;
      switch (event.kind) {
        case "checkpoint":
          h.onCheckpoint?.({
            seq: event.seq,
            docxUrl: event.docxUrl,
            sourceTool: event.sourceTool,
          });
          break;
        case "status":
          h.onStatus?.(event.message);
          break;
        case "error":
          h.onError?.(event.message);
          break;
        default:
          break;
      }
    };

    const connect = () => {
      if (cancelled) return;
      const source = new EventSource(
        `/api/workspaces/${workspaceId}/events`,
      );
      es = source;

      source.onopen = () => {
        if (cancelled) return;
        backoff = INITIAL_BACKOFF_MS;
        setConnected(true);
      };

      // The server emits typed events (`event: checkpoint`, etc.), so we
      // register listeners per kind rather than relying on the default
      // `onmessage` (which only fires for messages without an event name).
      source.addEventListener("checkpoint", (ev) =>
        parseAndDispatch(ev as MessageEvent<string>),
      );
      source.addEventListener("status", (ev) =>
        parseAndDispatch(ev as MessageEvent<string>),
      );
      source.addEventListener("error", (ev) => {
        // Named `error` events from the server carry a JSON payload. The
        // EventSource `error` event (connection failure) is NOT a
        // MessageEvent and has no `data` — parseAndDispatch will bail out.
        parseAndDispatch(ev as MessageEvent<string>);
      });

      source.onerror = () => {
        if (cancelled) return;
        setConnected(false);
        try {
          source.close();
        } catch {
          // ignore
        }
        if (es === source) es = null;
        // Exponential backoff with jitter.
        const jitter = Math.random() * 250;
        const delay = Math.min(backoff, MAX_BACKOFF_MS) + jitter;
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
        reconnectTimer = setTimeout(connect, delay);
      };
    };

    connect();

    return () => {
      cancelled = true;
      setConnected(false);
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (es) {
        try {
          es.close();
        } catch {
          // ignore
        }
        es = null;
      }
    };
  }, [workspaceId]);

  return { connected };
}
