import { useEffect, useRef } from "react";
import Message from "./Message";
import ThinkingIndicator from "./ThinkingIndicator";
import type { ChatMessage } from "../../lib/chat-types";

interface Props {
  messages: ChatMessage[];
  density: "compact" | "detailed";
  isStreaming: boolean;
}

export default function Conversation({ messages, density, isStreaming }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  // Auto-stick to bottom. We serialize block counts + last streaming text
  // into a dep so every token fires this effect during a streaming reply.
  const dep = messages
    .map((m) => {
      const last = m.blocks[m.blocks.length - 1];
      const tail = last && last.type === "text" ? last.text.length : 0;
      return `${m.id}:${m.blocks.length}:${tail}`;
    })
    .join("|");

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [dep, isStreaming]);

  // Show the thinking indicator when streaming but nothing is actively
  // being produced (no streaming text, no working tool call at the tail).
  let showThinking = false;
  if (isStreaming) {
    const lastMsg = messages[messages.length - 1];
    const lastBlock = lastMsg?.blocks[lastMsg.blocks.length - 1];
    const hasActiveText = lastBlock?.type === "text" && lastBlock.streaming;
    const hasWorkingTool = lastBlock?.type === "tool" && lastBlock.state === "working";
    showThinking = !hasActiveText && !hasWorkingTool;
  }

  return (
    <div className="chat-scroll" ref={ref}>
      {messages.map((m, i) => {
        // Group consecutive assistant messages into a visual "turn": only the
        // first one in the run renders the avatar + "Reducto" label.
        const prev = i > 0 ? messages[i - 1] : null;
        const showHeader = !prev || prev.role !== m.role;
        return (
          <Message
            key={m.id}
            message={m}
            density={density}
            showHeader={showHeader}
          />
        );
      })}
      {showThinking && (
        <div className="msg msg--continuation">
          <div className="msg-avatar" />
          <div className="msg-body">
            <ThinkingIndicator />
          </div>
        </div>
      )}
    </div>
  );
}
