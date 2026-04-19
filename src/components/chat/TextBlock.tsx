import { Streamdown } from "streamdown";
import StreamCursor from "./StreamCursor";

interface Props {
  text: string;
  streaming: boolean;
}

/**
 * A streamable text block. Agent responses are markdown — lists, bold,
 * inline code, code fences — so we render via `streamdown`, which is
 * built for progressively-arriving markdown (parses tolerantly while
 * tokens are still landing).
 */
export default function TextBlock({ text, streaming }: Props) {
  return (
    <div className="msg-text">
      <Streamdown>{text}</Streamdown>
      {streaming && <StreamCursor />}
    </div>
  );
}
