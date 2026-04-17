import type { ReactNode } from "react";
import Icon, { type IconName } from "../icons/Icon";
import { cn } from "../ui/cn";

export interface ToolPillProps {
  state: "working" | "done" | "error";
  name?: string;
  label: string;
  icon?: IconName;
  detail?: ReactNode;
  body?: ReactNode;
  density?: "compact" | "detailed";
}

export default function ToolPill({
  state,
  label,
  icon,
  detail,
  body,
  density = "compact",
}: ToolPillProps) {
  const stateClass = state === "working" ? "working" : state === "done" ? "done" : "error";
  const detailed = density === "detailed" && Boolean(body);

  const iconEl =
    state === "working" ? (
      <span className="tp-spinner" aria-hidden />
    ) : state === "done" ? (
      <Icon name="check" size={12} strokeWidth={2} />
    ) : state === "error" ? (
      <Icon name="x" size={12} strokeWidth={2} />
    ) : (
      <Icon name={icon ?? "zap"} size={12} />
    );

  if (detailed) {
    return (
      <div className={cn("tool-pill detailed", stateClass)}>
        <div className="tp-top">
          <span className="tp-icon">{iconEl}</span>
          <span className="tp-label">{label}</span>
          {detail && <span className="tp-detail">{detail}</span>}
        </div>
        {body && <div className="tp-body">{body}</div>}
      </div>
    );
  }

  return (
    <div className={cn("tool-pill", stateClass)}>
      <span className="tp-icon">{iconEl}</span>
      <span className="tp-label">{label}</span>
      {detail && <span className="tp-detail">{detail}</span>}
    </div>
  );
}
