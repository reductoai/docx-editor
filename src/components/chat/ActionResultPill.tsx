import Icon from "../icons/Icon";
import { cn } from "../ui/cn";

export interface ActionResultPillProps {
  tone: "success" | "warning" | "error";
  label: string;
  detail?: string;
  from?: string;
  to?: string;
  section?: string;
  onJump?: () => void;
}

/**
 * Repurposed change-pill. Surfaces a tracked-change or agent action result.
 * Unit 6 will wire onJump into the docx panel; for now the scripted driver
 * doesn't supply a handler, which makes the pill purely informational.
 */
export default function ActionResultPill({
  tone,
  label,
  detail,
  from,
  to,
  section,
  onJump,
}: ActionResultPillProps) {
  const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

  return (
    <div
      className={cn("action-pill", `action-pill--${tone}`, onJump && "action-pill--clickable")}
      onClick={onJump}
      role={onJump ? "button" : undefined}
      tabIndex={onJump ? 0 : undefined}
    >
      <div className="ap-tag">
        <Icon
          name={tone === "success" ? "check" : tone === "warning" ? "shield" : "x"}
          size={11}
          strokeWidth={2}
        />
        {label}
      </div>
      <div className="ap-body">
        {(from || to) && (
          <div className="ap-preview">
            {from && <del>{truncate(from, 40)}</del>}
            {from && to && <span className="ap-arrow"> → </span>}
            {to && <ins>{truncate(to, 80)}</ins>}
          </div>
        )}
        {detail && !from && !to && <div className="ap-detail">{detail}</div>}
        {(section || onJump) && (
          <div className="ap-loc">
            {section && (
              <>
                <Icon name="bookmark" size={10} />
                {section}
              </>
            )}
            {onJump && (
              <span className="ap-jump">
                Jump <Icon name="arrow" size={10} />
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
