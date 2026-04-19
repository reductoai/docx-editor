import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { SuperDocRefApi } from "./useDocxRef";

type AgentStatus = "idle" | "thinking" | "editing" | "error";

interface Props {
  documentName: string;
  onDocumentNameChange: (name: string) => void;
  editorRef: RefObject<SuperDocRefApi | null>;
  workspaceId: string;
  hasTrackedChanges?: boolean;
  agentStatus?: AgentStatus;
}

function statusLabel(status: AgentStatus): string {
  switch (status) {
    case "thinking":
      return "Agent is thinking";
    case "editing":
      return "Agent is editing";
    case "error":
      return "Agent error";
    case "idle":
    default:
      return "Idle";
  }
}

export default function DocxTitleBar({
  documentName,
  onDocumentNameChange,
  editorRef,
  workspaceId,
  hasTrackedChanges = false,
  agentStatus = "idle",
}: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(documentName);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) setDraft(documentName);
  }, [documentName, editing]);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  function commit() {
    const next = draft.trim();
    if (next && next !== documentName) onDocumentNameChange(next);
    else setDraft(documentName);
    setEditing(false);
  }

  function cancel() {
    setDraft(documentName);
    setEditing(false);
  }

  const [resolving, setResolving] = useState(false);

  async function resolveChanges(action: "accept" | "reject") {
    if (resolving) return;
    setResolving(true);
    try {
      const res = await fetch(
        `/api/workspaces/${workspaceId}/${action}-changes`,
        { method: "POST" },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        console.warn(
          `[DocxTitleBar] ${action}-changes failed:`,
          body?.error ?? res.status,
        );
      }
    } catch (err) {
      console.warn(`[DocxTitleBar] ${action}-changes request failed:`, err);
    } finally {
      setResolving(false);
    }
  }

  async function handleExport() {
    const ref = editorRef.current;
    if (!ref || typeof ref.save !== "function") {
      console.warn("[DocxTitleBar] save() unavailable on editor ref; no-op.");
      return;
    }
    try {
      const result = await ref.save();
      if (!result) {
        console.warn("[DocxTitleBar] save() returned null/undefined.");
        return;
      }
      let blob: Blob;
      if (typeof Blob !== "undefined" && result instanceof Blob) {
        blob = result;
      } else if (result instanceof ArrayBuffer) {
        blob = new Blob([result], {
          type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        });
      } else {
        console.warn("[DocxTitleBar] save() returned unexpected shape.");
        return;
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = documentName.endsWith(".docx")
        ? documentName
        : `${documentName}.docx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      console.warn("[DocxTitleBar] export failed:", err);
    }
  }

  return (
    <div className="docx-titlebar">
      <div className="docx-titlebar__left">
        {editing ? (
          <input
            ref={inputRef}
            className="docx-titlebar__name-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                cancel();
              }
            }}
          />
        ) : (
          <button
            type="button"
            className="docx-titlebar__name"
            onClick={() => setEditing(true)}
            title="Rename document"
          >
            {documentName}
          </button>
        )}
        <span
          className={`docx-titlebar__status docx-titlebar__status--${agentStatus}`}
          aria-label={statusLabel(agentStatus)}
          title={statusLabel(agentStatus)}
        >
          <span className="docx-titlebar__status-dot" />
          <span className="docx-titlebar__status-text">
            {statusLabel(agentStatus)}
          </span>
        </span>
      </div>
      <div className="docx-titlebar__actions">
        {hasTrackedChanges && (
          <>
            <button
              type="button"
              className="docx-btn docx-btn--ghost"
              disabled={resolving}
              onClick={() => resolveChanges("reject")}
            >
              {resolving ? "Processing…" : "Reject all"}
            </button>
            <button
              type="button"
              className="docx-btn docx-btn--primary"
              disabled={resolving}
              onClick={() => resolveChanges("accept")}
            >
              {resolving ? "Processing…" : "Accept all"}
            </button>
          </>
        )}
        <button
          type="button"
          className="docx-btn docx-btn--outline"
          onClick={handleExport}
        >
          Export
        </button>
      </div>
    </div>
  );
}
