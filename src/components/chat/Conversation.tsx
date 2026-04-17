import { useEffect, useRef } from "react";
import Message from "./Message";
import type { ChatMessage } from "../../lib/chat-types";

interface Props {
  messages: ChatMessage[];
  density: "compact" | "detailed";
}

export default function Conversation({ messages, density }: Props) {
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
  }, [dep]);

  return (
    <div className="chat-scroll" ref={ref}>
      {messages.map((m) => (
        <Message key={m.id} message={m} density={density} />
      ))}
    </div>
  );
}
