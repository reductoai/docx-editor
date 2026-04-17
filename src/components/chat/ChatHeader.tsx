import Icon from "../icons/Icon";

interface Props {
  subtitle?: string;
  onToggleTweaks?: () => void;
}

export default function ChatHeader({ subtitle, onToggleTweaks }: Props) {
  return (
    <div className="chat-header">
      <div className="ch-logo">
        <img src="/assets/logomark.svg" alt="" style={{ width: 18, height: 18 }} />
      </div>
      <div>
        <div className="ch-title">Reducto Editor</div>
        {subtitle && <div className="ch-sub">{subtitle}</div>}
      </div>
      <div className="ch-actions">
        <button type="button" className="ch-icon-btn" title="History">
          <Icon name="clock" size={14} />
        </button>
        <button type="button" className="ch-icon-btn" title="New thread">
          <Icon name="plus" size={14} />
        </button>
        <button
          type="button"
          className="ch-icon-btn"
          title="Tweaks"
          onClick={onToggleTweaks}
        >
          <Icon name="more" size={14} />
        </button>
      </div>
    </div>
  );
}
