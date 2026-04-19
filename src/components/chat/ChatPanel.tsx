import { useCallback, useEffect, useState } from "react";
import { useAgent } from "../../hooks/useAgent";
import { DEFAULT_MODEL_ID } from "../../lib/models";
import ChatHeader from "./ChatHeader";
import Composer, { type Attachment } from "./Composer";
import Conversation from "./Conversation";
import SessionChip from "./SessionChip";
import TweaksPanel, { type PillDensity } from "./TweaksPanel";

interface Props {
  workspaceId: string | null;
  documentName: string;
  /** Notifies the parent when the agent enters / exits a streaming turn. */
  onStreamingChange?: (isStreaming: boolean) => void;
}

export default function ChatPanel({
  workspaceId,
  documentName,
  onStreamingChange,
}: Props) {
  const {
    messages,
    isStreaming,
    errorMessage,
    sendMessage,
    cancel,
    dismissError,
    exportTrace,
  } = useAgent(workspaceId);
  const [pillDensity, setPillDensity] = useState<PillDensity>("compact");
  const [modelId, setModelId] = useState<string>(DEFAULT_MODEL_ID);
  // TODO(agent-authoring): wiring this to DocxEditor's `author` prop would
  // require threading a prop through App → DocxPanel → DocxEditor, which
  // exceeds the polish-unit scope control. Currently a no-op toggle.
  const [agentAuthoring, setAgentAuthoring] = useState(true);
  const [tweaksOpen, setTweaksOpen] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);

  // Bubble streaming transitions up to the parent so the DocxPanel can
  // pause its debounced PUTs during agent turns.
  useEffect(() => {
    onStreamingChange?.(isStreaming);
  }, [isStreaming, onStreamingChange]);

  // Clear attachments when workspace changes.
  useEffect(() => {
    setAttachments([]);
  }, [workspaceId]);

  const handleAttach = useCallback(
    async (file: File) => {
      if (!workspaceId) return;
      const form = new FormData();
      form.append("file", file);
      try {
        const res = await fetch(`/api/workspaces/${workspaceId}/attachments`, {
          method: "POST",
          body: form,
        });
        if (!res.ok) return;
        const data = (await res.json()) as { ok: boolean; name: string; path: string };
        if (data.ok) {
          setAttachments((prev) => [...prev, { name: data.name, path: data.path }]);
        }
      } catch {
        // Upload failed silently — user can retry.
      }
    },
    [workspaceId],
  );

  const handleRemoveAttachment = useCallback((index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleSubmit = useCallback(
    (text: string) => {
      let agentText = text;
      if (attachments.length > 0) {
        const lines = attachments.map(
          (att) => `[Attached file: ${att.name}] — read it at path: ./${att.path}`,
        );
        agentText = agentText
          ? `${agentText}\n\n${lines.join("\n")}`
          : lines.join("\n");
      }
      void sendMessage(agentText, {
        model: modelId,
        attachments: attachments.length > 0 ? attachments : undefined,
        displayText: text,
      });
      setAttachments([]);
    },
    [attachments, sendMessage, modelId],
  );

  const subtitle = workspaceId ? "Connected" : "Awaiting document";
  const composerPlaceholder = workspaceId
    ? "Ask Reducto to edit the document…"
    : "Open a document to start chatting";

  return (
    <div className="chat-panel" data-pill-density={pillDensity}>
      <ChatHeader subtitle={subtitle} onToggleTweaks={() => setTweaksOpen((v) => !v)} />
      <SessionChip
        documentName={documentName}
        status={workspaceId ? "ready" : "connecting"}
        meta={workspaceId ? "Session ready" : "Open a document to begin"}
      />
      {errorMessage && (
        <div className="chat-error-banner" role="alert">
          <span className="chat-error-banner__msg">{errorMessage}</span>
          <button
            type="button"
            className="chat-error-banner__dismiss"
            onClick={dismissError}
            aria-label="Dismiss error"
          >
            ×
          </button>
        </div>
      )}
      <Conversation messages={messages} density={pillDensity} isStreaming={isStreaming} />
      <Composer
        isStreaming={isStreaming || !workspaceId}
        placeholder={composerPlaceholder}
        onSubmit={handleSubmit}
        onStop={cancel}
        onAttach={handleAttach}
        onRemoveAttachment={handleRemoveAttachment}
        attachments={attachments}
        modelId={modelId}
        onModelChange={setModelId}
      />
      {workspaceId && (
        <div className="chat-metrics">
          <button
            type="button"
            className="chat-metrics__export"
            onClick={() => {
              void exportTrace();
            }}
            title="Download the full chat trace (messages, tool calls, events, server activity) as JSON for debugging"
          >
            export trace
          </button>
        </div>
      )}
      <TweaksPanel
        open={tweaksOpen}
        pillDensity={pillDensity}
        onPillDensityChange={setPillDensity}
        agentAuthoring={agentAuthoring}
        onAgentAuthoringChange={setAgentAuthoring}
      />
    </div>
  );
}
