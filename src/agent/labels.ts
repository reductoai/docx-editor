// Ported from reference/src/pi_docx_editor/agent.ts lines 168-192 plus helpers.
// Produces short, human-readable labels for tool calls to display in ToolPill
// while the agent streams.

const TOOL_LABEL_MAX_LENGTH = 160;
const TOOL_COMMAND_MAX_LENGTH = 140;
const TOOL_PATTERN_MAX_LENGTH = 72;

function truncateToolText(value: string, maxLength = TOOL_LABEL_MAX_LENGTH): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

function formatInlineToolValue(value: string, maxLength = TOOL_PATTERN_MAX_LENGTH): string {
  const truncated = truncateToolText(value, maxLength);
  if (!truncated) {
    return '""';
  }
  return /\s/.test(truncated) ? JSON.stringify(truncated) : truncated;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getStringArg(
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function getBooleanArg(
  args: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = args[key];
  return typeof value === "boolean" ? value : undefined;
}

function formatReadToolLabel(args: Record<string, unknown>): string {
  const path = getStringArg(args, "path") ?? ".";
  return truncateToolText(
    `read ${formatInlineToolValue(path, TOOL_COMMAND_MAX_LENGTH)}`,
  );
}

function formatWriteToolLabel(args: Record<string, unknown>): string {
  const path = getStringArg(args, "path") ?? ".";
  const content = getStringArg(args, "content");
  const suffix =
    content === undefined ? "" : ` (${content.length.toLocaleString()} chars)`;
  return truncateToolText(
    `write ${formatInlineToolValue(path, TOOL_COMMAND_MAX_LENGTH)}${suffix}`,
  );
}

function formatEditToolLabel(args: Record<string, unknown>): string {
  const path = getStringArg(args, "path") ?? ".";
  const edits = Array.isArray(args["edits"]) ? args["edits"] : [];
  const suffix =
    edits.length > 0
      ? ` (${edits.length} edit${edits.length === 1 ? "" : "s"})`
      : "";
  return truncateToolText(
    `edit ${formatInlineToolValue(path, TOOL_COMMAND_MAX_LENGTH)}${suffix}`,
  );
}

function formatGrepToolLabel(args: Record<string, unknown>): string {
  const pattern = getStringArg(args, "pattern");
  const path = getStringArg(args, "path") ?? ".";
  const glob = getStringArg(args, "glob");
  const flags: string[] = [];

  if (getBooleanArg(args, "ignoreCase")) {
    flags.push("ignore-case");
  }
  if (getBooleanArg(args, "literal")) {
    flags.push("literal");
  }
  if (glob) {
    flags.push(`glob ${formatInlineToolValue(glob)}`);
  }

  const suffix = flags.length > 0 ? ` (${flags.join(", ")})` : "";
  return truncateToolText(
    `grep ${formatInlineToolValue(pattern ?? "", TOOL_PATTERN_MAX_LENGTH)} in ${formatInlineToolValue(path, TOOL_COMMAND_MAX_LENGTH)}${suffix}`,
  );
}

function formatFindToolLabel(args: Record<string, unknown>): string {
  const pattern = getStringArg(args, "pattern");
  const path = getStringArg(args, "path") ?? ".";
  return truncateToolText(
    `find ${formatInlineToolValue(pattern ?? "", TOOL_PATTERN_MAX_LENGTH)} in ${formatInlineToolValue(path, TOOL_COMMAND_MAX_LENGTH)}`,
  );
}

function formatLsToolLabel(args: Record<string, unknown>): string {
  const path = getStringArg(args, "path") ?? ".";
  return truncateToolText(
    `ls ${formatInlineToolValue(path, TOOL_COMMAND_MAX_LENGTH)}`,
  );
}

function formatDocxToolLabel(args: Record<string, unknown>): string {
  const sub = getStringArg(args, "subcommand") ?? "";
  const extras = Array.isArray(args["args"]) ? (args["args"] as unknown[]) : [];
  const firstExtra = extras.find(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  const base = sub ? `docx-tool ${sub}` : "docx-tool";
  const suffix = firstExtra
    ? ` ${formatInlineToolValue(firstExtra, TOOL_COMMAND_MAX_LENGTH)}`
    : "";
  return truncateToolText(`${base}${suffix}`);
}

function formatGenericToolLabel(
  toolName: string,
  args: Record<string, unknown>,
): string {
  for (const key of ["path", "command", "pattern"]) {
    const value = getStringArg(args, key);
    if (value) {
      return truncateToolText(
        `${toolName} ${formatInlineToolValue(value, TOOL_COMMAND_MAX_LENGTH)}`,
      );
    }
  }
  return toolName;
}

export function formatToolExecutionLabel(
  toolName: string,
  args?: unknown,
): string {
  const record = isObjectRecord(args) ? args : {};
  switch (toolName) {
    case "bash": {
      const command = getStringArg(record, "command");
      return command
        ? truncateToolText(`bash ${command}`, TOOL_COMMAND_MAX_LENGTH)
        : "bash";
    }
    case "read":
      return formatReadToolLabel(record);
    case "write":
      return formatWriteToolLabel(record);
    case "edit":
      return formatEditToolLabel(record);
    case "grep":
      return formatGrepToolLabel(record);
    case "find":
      return formatFindToolLabel(record);
    case "ls":
      return formatLsToolLabel(record);
    case "docx_tool":
    case "docx-tool":
      return formatDocxToolLabel(record);
    default:
      return formatGenericToolLabel(toolName, record);
  }
}
