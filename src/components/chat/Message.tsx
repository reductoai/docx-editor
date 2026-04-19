import { cn } from "../ui/cn";
import ActionResultPill from "./ActionResultPill";
import TextBlock from "./TextBlock";
import ThinkingIndicator from "./ThinkingIndicator";
import ToolPill from "./ToolPill";
import type { ChatMessage } from "../../lib/chat-types";

interface Props {
  message: ChatMessage;
  density: "compact" | "detailed";
  /** When false, hides the avatar + author name so consecutive messages from
   *  the same role visually collapse into a single turn. */
  showHeader?: boolean;
}

export default function Message({ message, density, showHeader = true }: Props) {
  const isUser = message.role === "user";
  return (
    <div
      className={cn(
        "msg",
        isUser ? "user" : "agent",
        !showHeader && "msg--continuation",
      )}
    >
      <div className="msg-avatar" aria-hidden={!showHeader}>
        {showHeader && (isUser ? (
          "A"
        ) : (
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M12 3l1.88 5.64L20 11l-6.12 2.36L12 19l-1.88-5.64L4 11l6.12-2.36z" />
          </svg>
        ))}
      </div>
      <div className="msg-body">
        {showHeader && (
          <div className="msg-author">{isUser ? "You" : "Reducto"}</div>
        )}
        {message.blocks.map((block) => {
          if (block.type === "text") {
            return <TextBlock key={block.id} text={block.text} streaming={block.streaming} />;
          }
          if (block.type === "tool") {
            return (
              <ToolPill
                key={block.id}
                state={block.state}
                name={block.name}
                icon={block.icon}
                label={block.label}
                detail={block.detail}
                body={block.body}
                density={density}
                args={block.args}
                result={block.result}
              />
            );
          }
          if (block.type === "action") {
            return (
              <ActionResultPill
                key={block.id}
                tone={block.tone}
                label={block.label}
                detail={block.detail}
                from={block.from}
                to={block.to}
                section={block.section}
              />
            );
          }
          if (block.type === "thinking") {
            return <ThinkingIndicator key={block.id} />;
          }
          return null;
        })}
      </div>
    </div>
  );
}
