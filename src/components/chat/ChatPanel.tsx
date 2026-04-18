import { useEffect, useState } from "react";
import { useAgent } from "../../hooks/useAgent";
import ChatHeader from "./ChatHeader";
import Composer from "./Composer";
import ComposerHints from "./ComposerHints";
import Conversation from "./Conversation";
import SessionChip from "./SessionChip";
import TweaksPanel, { type PillDensity } from "./TweaksPanel";

interface Props {
  workspaceId: string | null;
  documentName: string;
  /** Notifies the parent when the agent enters / exits a streaming turn. */
  onStreamingChange?: (isStreaming: boolean) => void;
}

const HINTS = [
  "Strengthen §2 standard of care",
  "Add residuals carve-out",
  "Why Delaware over New York?",
];

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
  // TODO(agent-authoring): wiring this to DocxEditor's `author` prop would
  // require threading a prop through App → DocxPanel → DocxEditor, which
  // exceeds the polish-unit scope control. Currently a no-op toggle.
  const [agentAuthoring, setAgentAuthoring] = useState(true);
  const [tweaksOpen, setTweaksOpen] = useState(false);
  const [prefill, setPrefillNonce] = useState<{ text: string; nonce: number } | undefined>(
    undefined,
  );

  // Bubble streaming transitions up to the parent so the DocxPanel can
  // pause its debounced PUTs during agent turns.
  useEffect(() => {
    onStreamingChange?.(isStreaming);
  }, [isStreaming, onStreamingChange]);

  const subtitle = workspaceId ? "Connected" : "Awaiting document";
  const composerPlaceholder = workspaceId
    ? "Ask Reducto to edit the document…"
    : "Open a DOCX to start chatting";

  return (
    <div className="chat-panel" data-pill-density={pillDensity}>
      <ChatHeader subtitle={subtitle} onToggleTweaks={() => setTweaksOpen((v) => !v)} />
      <SessionChip
        documentName={documentName}
        status={workspaceId ? "ready" : "connecting"}
        meta={workspaceId ? "Session ready" : "Open a DOCX to begin"}
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
      <Conversation messages={messages} density={pillDensity} />
      <ComposerHints
        hints={HINTS}
        onPick={(h) => setPrefillNonce({ text: h, nonce: Date.now() })}
      />
      <Composer
        isStreaming={isStreaming || !workspaceId}
        placeholder={composerPlaceholder}
        onSubmit={(text) => {
          void sendMessage(text);
        }}
        onStop={cancel}
        prefill={prefill?.text}
        prefillNonce={prefill?.nonce}
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
