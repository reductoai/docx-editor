import { useCallback, useEffect, useRef, useState } from "react";
import type { SuperDocRefApi } from "./useDocxRef";

interface Options {
  workspaceId: string | null;
  editorRef: React.RefObject<SuperDocRefApi | null>;
  isAgentTurn: boolean;
}

interface Result {
  onChange: () => void;
  toast: string | null;
}

const DEBOUNCE_MS = 500;

/**
 * Debounces editor `onChange` events and PUTs the current document buffer
 * to `/api/workspaces/:id/doc` as a raw body.
 *
 * Behavior when an agent turn is in progress:
 *   - onChange events are captured (marked as "pending") but no PUT fires.
 *   - When `isAgentTurn` transitions back to false and we have a pending
 *     edit, we flush once immediately.
 *   - If a PUT races and comes back 409 `turn-in-progress`, we surface a
 *     "queued" toast and retry once after the next agent-turn-ends tick.
 */
export function useDocxSync(opts: Options): Result {
  const { workspaceId, editorRef, isAgentTurn } = opts;
  const [toast, setToast] = useState<string | null>(null);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlightRef = useRef<AbortController | null>(null);

  // Keep latest values in refs so debounce closure doesn't go stale.
  const workspaceIdRef = useRef(workspaceId);
  const isAgentTurnRef = useRef(isAgentTurn);
  useEffect(() => {
    workspaceIdRef.current = workspaceId;
  }, [workspaceId]);

  // Tracks whether at least one onChange fired that hasn't been PUT yet.
  // Used so we can flush when `isAgentTurn` flips false or retry once after
  // a 409.
  const pendingEditRef = useRef(false);
  // Set to true when a PUT fails with 409 `turn-in-progress`; a subsequent
  // transition of isAgentTurn from true→false triggers one retry.
  const retryAfterTurnRef = useRef(false);

  const flush = useCallback(async () => {
    const wsid = workspaceIdRef.current;
    if (!wsid) return;
    if (isAgentTurnRef.current) {
      // Keep the pending flag set; a subsequent turn-end tick will flush.
      pendingEditRef.current = true;
      return;
    }
    const ref = editorRef.current;
    if (!ref || typeof ref.save !== "function") return;

    let body: ArrayBuffer | null = null;
    try {
      const saved = await ref.save();
      if (!saved) return;
      if (saved instanceof ArrayBuffer) {
        body = saved;
      } else if (typeof Blob !== "undefined" && saved instanceof Blob) {
        body = await saved.arrayBuffer();
      } else {
        // Unknown shape — bail out safely.
        return;
      }
    } catch (err) {
      console.warn("[useDocxSync] save() threw:", err);
      return;
    }

    // Cancel any in-flight sync to keep only the latest buffer on the wire.
    if (inFlightRef.current) {
      inFlightRef.current.abort();
    }
    const controller = new AbortController();
    inFlightRef.current = controller;

    // Optimistically clear the pending flag; we re-arm it on 409 below.
    pendingEditRef.current = false;

    try {
      const res = await fetch(`/api/workspaces/${wsid}/doc`, {
        method: "PUT",
        headers: {
          "Content-Type":
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        },
        body,
        signal: controller.signal,
      });
      if (res.status === 409) {
        let kind: string | null = null;
        try {
          const payload = (await res.json()) as { error?: string };
          kind = payload?.error ?? null;
        } catch {
          // ignore — plain 409 still triggers a generic toast below.
        }
        if (kind === "turn-in-progress") {
          setToast("agent is editing — your change was queued");
          // Keep the edit marked pending and queue a retry for when the
          // agent turn ends.
          pendingEditRef.current = true;
          retryAfterTurnRef.current = true;
        } else {
          setToast("Couldn't save: document is locked.");
        }
      } else if (!res.ok) {
        setToast(`Save failed (${res.status}).`);
      } else if (toast) {
        setToast(null);
      }
    } catch (err) {
      if ((err as DOMException)?.name === "AbortError") return;
      console.warn("[useDocxSync] PUT failed:", err);
    } finally {
      if (inFlightRef.current === controller) {
        inFlightRef.current = null;
      }
    }
  }, [editorRef, toast]);

  // React to isAgentTurn transitions. When the agent turn ends and we have
  // a pending edit (or a queued retry), fire a flush immediately.
  useEffect(() => {
    const wasTurn = isAgentTurnRef.current;
    isAgentTurnRef.current = isAgentTurn;
    if (wasTurn && !isAgentTurn) {
      if (pendingEditRef.current || retryAfterTurnRef.current) {
        retryAfterTurnRef.current = false;
        // Clear any debounce timer — we're flushing now.
        if (timerRef.current) {
          clearTimeout(timerRef.current);
          timerRef.current = null;
        }
        void flush();
      }
    }
  }, [isAgentTurn, flush]);

  const onChange = useCallback(() => {
    pendingEditRef.current = true;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      void flush();
    }, DEBOUNCE_MS);
  }, [flush]);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      if (inFlightRef.current) inFlightRef.current.abort();
    };
  }, []);

  return { onChange, toast };
}
