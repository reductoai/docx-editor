// Three dots with staggered bounce; styles are in .thinking / .thinking .dot.
export default function ThinkingIndicator() {
  return (
    <div className="thinking" aria-label="Thinking">
      <span className="dot" />
      <span className="dot" />
      <span className="dot" />
    </div>
  );
}
