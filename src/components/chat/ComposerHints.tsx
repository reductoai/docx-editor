interface Props {
  hints: string[];
  onPick: (hint: string) => void;
}

export default function ComposerHints({ hints, onPick }: Props) {
  if (hints.length === 0) return null;
  return (
    <div className="composer-hints">
      {hints.map((h) => (
        <button
          key={h}
          type="button"
          className="composer-hint"
          onClick={() => onPick(h)}
        >
          {h}
        </button>
      ))}
    </div>
  );
}
