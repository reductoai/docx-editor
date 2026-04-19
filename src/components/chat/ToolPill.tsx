import { useMemo, useState, type ReactNode } from "react";
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
  /** Raw tool invocation args (any JSON-serializable value). Shown when
   *  the user expands the pill. */
  args?: unknown;
  /** Raw tool result payload. Shown when expanded. */
  result?: unknown;
}

export default function ToolPill({
  state,
  label,
  icon,
  detail,
  body,
  density = "compact",
  args,
  result,
}: ToolPillProps) {
  const [expanded, setExpanded] = useState(false);
  const stateClass = state === "working" ? "working" : state === "done" ? "done" : "error";
  const detailed = density === "detailed" && Boolean(body);

  const argsJson = useMemo(() => safeStringify(args), [args]);
  const resultJson = useMemo(() => {
    // The tool result shape coming out of pi-coding-agent's tools is
    // usually `{ content: [{ type: "text", text: "..." }] }`. Surface
    // the inner text verbatim when we can so it reads like CLI output;
    // otherwise fall back to the raw JSON.
    const text = extractResultText(result);
    if (text !== null) return text;
    return safeStringify(result);
  }, [result]);

  const hasExpandableContent =
    (argsJson && argsJson !== "undefined") ||
    (resultJson && resultJson !== "undefined");

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

  const togglable = hasExpandableContent;
  const topRow = (
    <>
      <span className="tp-icon">{iconEl}</span>
      <span className="tp-label">{label}</span>
      {detail && <span className="tp-detail">{detail}</span>}
      {togglable && (
        <span
          className={cn("tp-chevron", expanded && "tp-chevron--open")}
          aria-hidden
        >
          <Icon name="caret" size={10} />
        </span>
      )}
    </>
  );

  if (detailed) {
    return (
      <div
        className={cn(
          "tool-pill detailed",
          stateClass,
          expanded && "tool-pill--expanded",
        )}
      >
        <button
          type="button"
          className="tp-top tp-top--button"
          onClick={togglable ? () => setExpanded((v) => !v) : undefined}
          disabled={!togglable}
          aria-expanded={expanded}
        >
          {topRow}
        </button>
        {body && <div className="tp-body">{body}</div>}
        {expanded && togglable && (
          <ExpandedDetails argsJson={argsJson} resultJson={resultJson} />
        )}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "tool-pill",
        stateClass,
        togglable && "tool-pill--clickable",
        expanded && "tool-pill--expanded",
      )}
    >
      <button
        type="button"
        className="tool-pill__toggle"
        onClick={togglable ? () => setExpanded((v) => !v) : undefined}
        disabled={!togglable}
        aria-expanded={expanded}
      >
        {topRow}
      </button>
      {expanded && togglable && (
        <ExpandedDetails argsJson={argsJson} resultJson={resultJson} />
      )}
    </div>
  );
}

function ExpandedDetails({
  argsJson,
  resultJson,
}: {
  argsJson: string;
  resultJson: string;
}) {
  return (
    <div className="tool-pill__details">
      {argsJson && argsJson !== "undefined" && (
        <div className="tool-pill__section">
          <div className="tool-pill__section-title">Arguments</div>
          <pre className="tool-pill__code">{argsJson}</pre>
        </div>
      )}
      {resultJson && resultJson !== "undefined" && (
        <div className="tool-pill__section">
          <div className="tool-pill__section-title">Result</div>
          <pre className="tool-pill__code">{resultJson}</pre>
        </div>
      )}
    </div>
  );
}

function safeStringify(value: unknown): string {
  if (value === undefined) return "undefined";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function extractResultText(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const content = (result as { content?: Array<{ type?: string; text?: string }> })
    .content;
  if (!Array.isArray(content)) return null;
  const parts = content
    .filter((c) => c?.type === "text" && typeof c.text === "string")
    .map((c) => c.text!);
  if (parts.length === 0) return null;
  return parts.join("\n");
}
