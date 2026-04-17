import { cn } from "../ui/cn";

export type PillDensity = "compact" | "detailed";

interface Props {
  open: boolean;
  pillDensity: PillDensity;
  onPillDensityChange: (value: PillDensity) => void;
  agentAuthoring: boolean;
  onAgentAuthoringChange: (value: boolean) => void;
  onClose?: () => void;
}

export default function TweaksPanel({
  open,
  pillDensity,
  onPillDensityChange,
  agentAuthoring,
  onAgentAuthoringChange,
}: Props) {
  return (
    <div className={cn("tweaks-panel", !open && "hidden")} role="dialog" aria-label="Tweaks">
      <h3>Tweaks</h3>
      <div className="tweak-row">
        <div className="tweak-label">Tool-call pill density</div>
        <div className="tweak-segmented">
          <button
            type="button"
            className={pillDensity === "compact" ? "active" : ""}
            onClick={() => onPillDensityChange("compact")}
          >
            Compact
          </button>
          <button
            type="button"
            className={pillDensity === "detailed" ? "active" : ""}
            onClick={() => onPillDensityChange("detailed")}
          >
            Detailed
          </button>
        </div>
      </div>
      <div className="tweak-row">
        <div className="tweak-label">Agent authoring mode</div>
        <div className="tweak-segmented">
          <button
            type="button"
            className={!agentAuthoring ? "active" : ""}
            onClick={() => onAgentAuthoringChange(false)}
          >
            Off
          </button>
          <button
            type="button"
            className={agentAuthoring ? "active" : ""}
            onClick={() => onAgentAuthoringChange(true)}
          >
            On
          </button>
        </div>
      </div>
      <div
        style={{
          fontSize: 10.5,
          color: "var(--fg-secondary)",
          marginTop: 8,
          lineHeight: 1.5,
        }}
      >
        Agent authoring lets Reducto propose tracked changes directly in the document.
      </div>
    </div>
  );
}
