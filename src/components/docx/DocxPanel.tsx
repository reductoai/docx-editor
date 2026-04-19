import { useCallback, useEffect, useRef, useState } from "react";
import {
  DocxEditor,
  type DocxEditorRef,
} from "@eigenpal/docx-js-editor";
import "@eigenpal/docx-js-editor/styles.css";
import DocxTitleBar from "./DocxTitleBar";
import { useDocxRef, type SuperDocRefApi } from "./useDocxRef";
import { useDocxSync } from "./useDocxSync";
import { useWorkspaceEvents } from "../../hooks/useWorkspaceEvents";

interface Props {
  workspaceId: string | null;
  onWorkspaceCreated: (id: string) => void;
  documentName: string;
  onDocumentNameChange: (name: string) => void;
  isAgentTurn?: boolean;
  /** Fired after a workspace checkpoint has been applied to the editor. */
  onCheckpointApplied?: () => void;
}

const AGENT_TOAST_MS = 3000;

// --- Comments-sidebar persistence ------------------------------------------
// `@eigenpal/docx-js-editor@0.0.35` holds the comments-sidebar open/closed
// state in an internal `useState(false)` and resets it every time
// `loadDocumentBuffer` runs (via its internal `Fe()` cleanup). There's no
// prop / imperative method to control it. The toolbar button is rendered
// with `aria-pressed={active}` and `aria-label="Toggle comments sidebar"`,
// so we read/click it directly.
const SIDEBAR_TOGGLE_SELECTOR = '[aria-label="Toggle comments sidebar"]';

function findCommentsToggleButton(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(SIDEBAR_TOGGLE_SELECTOR);
}

function isCommentsSidebarOpen(): boolean {
  const btn = findCommentsToggleButton();
  return btn?.getAttribute("aria-pressed") === "true";
}

/**
 * Re-opens the comments sidebar if a post-`loadDocumentBuffer` render
 * left it closed. We poll briefly because the toolbar button re-renders
 * across the load and the DOM may need a tick to reflect the library's
 * current state.
 */
function restoreCommentsSidebar(): void {
  const started = Date.now();
  const attempt = () => {
    const btn = findCommentsToggleButton();
    if (btn) {
      if (btn.getAttribute("aria-pressed") !== "true") btn.click();
      return;
    }
    if (Date.now() - started < 1500) {
      setTimeout(attempt, 60);
    }
  };
  // Small delay lets React commit the post-load render before we peek.
  setTimeout(attempt, 80);
}

export default function DocxPanel({
  workspaceId,
  onWorkspaceCreated,
  documentName,
  onDocumentNameChange,
  isAgentTurn = false,
  onCheckpointApplied,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragActive, setDragActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  // Editor state (only used when workspaceId is set).
  const [buffer, setBuffer] = useState<ArrayBuffer | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Transient "updated by agent" toast — overlays the sync toast when present.
  const [agentToast, setAgentToast] = useState<string | null>(null);
  const agentToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Underlying library ref + our contract ref.
  const libraryRef = useRef<DocxEditorRef | null>(null);
  const apiRef = useDocxRef();

  // Track the last checkpoint seq we've applied to the editor so stale
  // events (out-of-order delivery, reconnect replays) are dropped.
  const lastAppliedSeqRef = useRef(0);

  // Wire apiRef to delegate to libraryRef. acceptAll/rejectAll are not in the
  // installed version's ref API — log-warn and no-op (handled in title bar).
  useEffect(() => {
    apiRef.current = {
      loadDocumentBuffer: (buf) => libraryRef.current?.loadDocumentBuffer(buf),
      save: () => libraryRef.current?.save() ?? null,
      acceptAll: () => {
        console.warn(
          "[DocxPanel] acceptAll() not provided by @eigenpal/docx-js-editor@0.0.35; no-op."
        );
      },
      rejectAll: () => {
        console.warn(
          "[DocxPanel] rejectAll() not provided by @eigenpal/docx-js-editor@0.0.35; no-op."
        );
      },
    } satisfies SuperDocRefApi;
    return () => {
      apiRef.current = null;
    };
    // apiRef is stable across renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { onChange: onEditorChange, toast } = useDocxSync({
    workspaceId,
    editorRef: apiRef,
    isAgentTurn,
  });

  const showAgentToast = useCallback((message: string) => {
    setAgentToast(message);
    if (agentToastTimerRef.current) {
      clearTimeout(agentToastTimerRef.current);
    }
    agentToastTimerRef.current = setTimeout(() => {
      setAgentToast(null);
      agentToastTimerRef.current = null;
    }, AGENT_TOAST_MS);
  }, []);

  // Reset checkpoint accounting when the workspace changes.
  useEffect(() => {
    lastAppliedSeqRef.current = 0;
  }, [workspaceId]);

  // Clear any pending agent toast on unmount.
  useEffect(() => {
    return () => {
      if (agentToastTimerRef.current) {
        clearTimeout(agentToastTimerRef.current);
        agentToastTimerRef.current = null;
      }
    };
  }, []);

  // Subscribe to workspace events — on checkpoint, reload the editor buffer.
  useWorkspaceEvents(workspaceId, {
    onCheckpoint: ({ seq, docxUrl, sourceTool }) => {
      if (seq <= lastAppliedSeqRef.current) return;
      // Fire-and-forget: fetch the URL verbatim (it already embeds `?seq=N`).
      void (async () => {
        try {
          const res = await fetch(docxUrl);
          if (!res.ok) {
            console.warn(
              `[DocxPanel] checkpoint fetch failed (${res.status}) for seq=${seq}`,
            );
            return;
          }
          const buf = await res.arrayBuffer();
          // Re-check after the await in case a newer checkpoint already landed.
          if (seq <= lastAppliedSeqRef.current) return;
          // Snapshot the comments-sidebar state BEFORE the reload so we
          // can restore it if the library's internal loadDocument resets
          // it. `loadDocument` calls `Fe()` which sets `an(false)` and
          // resets the "auto-open if there are tracked changes" guard;
          // the re-open effect doesn't always win the race on a fresh
          // parse, leaving the sidebar closed between checkpoints. We
          // only re-open if the user had it open before — closing is
          // still respected.
          const wasSidebarOpen = isCommentsSidebarOpen();
          await libraryRef.current?.loadDocumentBuffer(buf);
          lastAppliedSeqRef.current = seq;
          if (wasSidebarOpen) restoreCommentsSidebar();
          onCheckpointApplied?.();
          showAgentToast(
            sourceTool
              ? `Updated by agent (${sourceTool})`
              : "Updated by agent",
          );
        } catch (err) {
          console.warn(
            `[DocxPanel] failed to apply checkpoint seq=${seq}:`,
            err,
          );
        }
      })();
    },
    onError: (message) => {
      console.warn("[DocxPanel] workspace error event:", message);
    },
  });

  // Fetch buffer when workspace is set.
  useEffect(() => {
    if (!workspaceId) {
      setBuffer(null);
      setLoadError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    fetch(`/api/workspaces/${workspaceId}/doc`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`Failed to load document (${res.status})`);
        return res.arrayBuffer();
      })
      .then((buf) => {
        if (!cancelled) setBuffer(buf);
      })
      .catch((err) => {
        if (!cancelled) setLoadError((err as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const handleFile = useCallback(
    async (file: File) => {
      setError(null);
      if (!file.name.toLowerCase().endsWith(".docx")) {
        setError("Only .docx files are supported.");
        return;
      }
      setUploading(true);
      try {
        const form = new FormData();
        form.append("file", file);
        const res = await fetch("/api/workspaces", {
          method: "POST",
          body: form,
        });
        if (!res.ok) {
          setError(`Upload failed: ${res.status}`);
          return;
        }
        const payload = (await res.json()) as { workspaceId: string };
        onDocumentNameChange(file.name);
        onWorkspaceCreated(payload.workspaceId);
      } catch (err) {
        setError(`Upload failed: ${(err as Error).message}`);
      } finally {
        setUploading(false);
      }
    },
    [onDocumentNameChange, onWorkspaceCreated]
  );

  if (!workspaceId) {
    return (
      <div className="docx-panel">
        <div className="docx-panel__empty">
          <div
            className={`docx-panel__dropzone${
              dragActive ? " docx-panel__dropzone--active" : ""
            }`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragActive(true);
            }}
            onDragLeave={() => setDragActive(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragActive(false);
              const file = e.dataTransfer.files?.[0];
              if (file) void handleFile(file);
            }}
          >
            <h2>Open a DOCX</h2>
            <p>Drop a file or choose one to start a session.</p>
            <div className="docx-panel__dropzone-actions">
              <input
                ref={inputRef}
                type="file"
                accept=".docx"
                style={{ display: "none" }}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void handleFile(file);
                }}
              />
              <button
                className="docx-btn docx-btn--primary"
                disabled={uploading}
                onClick={() => inputRef.current?.click()}
              >
                {uploading ? "Uploading…" : "Choose file"}
              </button>
            </div>
            {error && <p className="docx-panel__error">{error}</p>}
          </div>
        </div>
      </div>
    );
  }

  const visibleToast = agentToast ?? toast;

  return (
    <div className="docx-panel">
      <DocxTitleBar
        documentName={documentName}
        onDocumentNameChange={onDocumentNameChange}
        editorRef={apiRef}
      />
      <div className="docx-panel__editor">
        {loading && (
          <div className="docx-panel__status">Loading document…</div>
        )}
        {loadError && (
          <div className="docx-panel__status docx-panel__status--error">
            {loadError}
          </div>
        )}
        {buffer && !loading && !loadError && (
          <DocxEditor
            ref={libraryRef}
            documentBuffer={buffer}
            mode="suggesting"
            author="You"
            showToolbar
            showRuler={false}
            showOutline={false}
            showOutlineButton={false}
            showZoomControl={false}
            showPrintButton={false}
            documentName={documentName}
            documentNameEditable={false}
            onChange={onEditorChange}
          />
        )}
      </div>
      {visibleToast && <div className="docx-panel__toast">{visibleToast}</div>}
    </div>
  );
}
