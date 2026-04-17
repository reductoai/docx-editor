// Blinking caret shown at the end of a streaming text block.
// CSS lives in src/styles/editor.css under `.stream-cursor`.
export default function StreamCursor() {
  return <span className="stream-cursor" aria-hidden />;
}
