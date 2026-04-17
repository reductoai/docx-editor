import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import Icon from "../icons/Icon";

interface Props {
  isStreaming: boolean;
  onSubmit: (text: string) => void;
  onStop?: () => void;
  placeholder?: string;
  initialText?: string;
  /** Imperative hint: when this string changes, the text is replaced. */
  prefill?: string;
  /** Bump to re-apply the same prefill string (e.g. user taps the same hint twice). */
  prefillNonce?: number;
}

export default function Composer({
  isStreaming,
  onSubmit,
  onStop,
  placeholder = "Ask Reducto to edit the document…",
  initialText = "",
  prefill,
  prefillNonce,
}: Props) {
  const [text, setText] = useState(initialText);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (prefill !== undefined) {
      setText(prefill);
      taRef.current?.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill, prefillNonce]);

  // Auto-grow to match content up to the CSS max-height (120px).
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(120, Math.max(20, el.scrollHeight))}px`;
  }, [text]);

  const submit = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed || isStreaming) return;
    onSubmit(trimmed);
    setText("");
  }, [text, isStreaming, onSubmit]);

  const handleKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="chat-composer">
      <div className="composer-box">
        <textarea
          ref={taRef}
          className="composer-input"
          placeholder={placeholder}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKey}
          rows={1}
          disabled={isStreaming}
        />
        <div className="composer-row">
          <button type="button" className="cr-btn" title="Attach" disabled={isStreaming}>
            <Icon name="plus" size={14} />
          </button>
          <button
            type="button"
            className="cr-btn"
            title="Reference section"
            disabled={isStreaming}
          >
            <Icon name="atsign" size={14} />
          </button>
          <button type="button" className="cr-btn" title="Link" disabled={isStreaming}>
            <Icon name="link" size={14} />
          </button>
          <div className="composer-model" role="button" tabIndex={0}>
            <span
              style={{
                width: 5,
                height: 5,
                background: "var(--plum-700)",
                borderRadius: "50%",
                display: "inline-block",
              }}
              aria-hidden
            />
            Claude Sonnet 4.5
            <Icon name="caret" size={10} />
          </div>
          <div className="cr-spacer" />
          {isStreaming ? (
            <button
              type="button"
              className="composer-send composer-send--stop"
              onClick={onStop}
            >
              <Icon name="stop" size={11} /> Stop
            </button>
          ) : (
            <button
              type="button"
              className="composer-send"
              disabled={!text.trim()}
              onClick={submit}
            >
              <Icon name="send" size={11} /> Send
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
