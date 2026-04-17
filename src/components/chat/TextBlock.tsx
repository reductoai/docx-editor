import StreamCursor from "./StreamCursor";

interface Props {
  text: string;
  streaming: boolean;
}

/**
 * A streamable text block. The driver feeds progressively-longer strings while
 * `streaming` is true; once the final slice arrives it flips to false and the
 * blinking cursor is removed.
 *
 * The scripted corpus contains a small amount of inline <strong>/<em>/<br>
 * markup, which we render via dangerouslySetInnerHTML since the source is
 * trusted (it's our own scripted content — not agent-authored HTML).
 */
export default function TextBlock({ text, streaming }: Props) {
  return (
    <div className="msg-text">
      <span dangerouslySetInnerHTML={{ __html: text }} />
      {streaming && <StreamCursor />}
    </div>
  );
}
