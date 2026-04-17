import Icon from "../icons/Icon";

interface Props {
  documentName: string;
  status?: "ready" | "connecting" | "error";
  meta?: string;
}

const STATUS_LABEL: Record<NonNullable<Props["status"]>, string> = {
  ready: "Ready",
  connecting: "Connecting",
  error: "Error",
};

const STATUS_COLOR: Record<NonNullable<Props["status"]>, string> = {
  ready: "var(--pine-600)",
  connecting: "var(--honey-500)",
  error: "var(--carmine-500)",
};

/**
 * Session chip (repurposed chat-doc-chip from the design). Shows the active
 * document name plus a lightweight status dot. Unit 6 will drive the status
 * from real agent state; we default to 'ready' today.
 */
export default function SessionChip({ documentName, status = "ready", meta }: Props) {
  return (
    <div className="chat-doc-chip">
      <div className="file-icon">
        <Icon name="file" size={12} strokeWidth={1.6} />
      </div>
      <div className="file-info">
        <div className="file-name">{documentName}</div>
        {meta && <div className="file-meta">{meta}</div>}
      </div>
      <div className="file-status">
        <span
          style={{
            width: 6,
            height: 6,
            background: STATUS_COLOR[status],
            borderRadius: "50%",
            display: "inline-block",
          }}
          aria-hidden
        />
        {STATUS_LABEL[status]}
      </div>
    </div>
  );
}
