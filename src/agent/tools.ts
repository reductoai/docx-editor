// Browser-side tool definitions. Each tool POSTs JSON to the matching
// `/api/tools/<name>` endpoint on the Hono server and returns the JSON
// result to the agent.
//
// `AgentTool.parameters` is typed as a typebox `TSchema`, so we mirror the
// zod schemas from `src/lib/tool-schemas.ts` into typebox shapes here.
// The canonical source of truth for argument validation still lives on the
// server — this schema only tells the model which fields to emit.

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@mariozechner/pi-ai";
import {
  bashArgsSchema,
  docxToolArgsSchema,
  editArgsSchema,
  findArgsSchema,
  grepArgsSchema,
  lsArgsSchema,
  readArgsSchema,
  writeArgsSchema,
} from "../lib/tool-schemas";
import type { ZodObject, ZodRawShape } from "zod";

interface ToolServerError {
  ok: false;
  error: string;
}

interface ToolServerSuccess {
  ok: true;
  result: unknown;
}

type ToolServerResponse = ToolServerSuccess | ToolServerError;

async function callToolEndpoint(
  route: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  const response = await fetch(`/api/tools/${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  let parsed: ToolServerResponse | null = null;
  try {
    parsed = (await response.json()) as ToolServerResponse;
  } catch {
    parsed = null;
  }
  if (!response.ok || !parsed || parsed.ok === false) {
    const errorMessage =
      parsed && parsed.ok === false && parsed.error
        ? parsed.error
        : `${response.status} ${response.statusText || "request failed"}`;
    throw new Error(errorMessage);
  }
  return parsed.result;
}

function makeExecute(route: string, workspaceId: string) {
  return async (
    _toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ) => {
    const result = await callToolEndpoint(
      route,
      { workspaceId, ...params },
      signal,
    );
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
      details: result,
    };
  };
}

// --- Typebox mirrors of the zod schemas in src/lib/tool-schemas.ts ---------

const bashSchema = Type.Object({
  command: Type.String({ description: "Bash command to run in the workspace." }),
  cwd: Type.Optional(
    Type.String({
      description: "Optional working directory relative to the workspace root.",
    }),
  ),
  timeoutMs: Type.Optional(
    Type.Number({ description: "Timeout in milliseconds (max 300000)." }),
  ),
});

const readSchema = Type.Object({
  path: Type.String({
    description: "Workspace-relative path to the file to read.",
  }),
  offset: Type.Optional(
    Type.Number({ description: "Line number to start reading from (0-indexed)." }),
  ),
  limit: Type.Optional(
    Type.Number({ description: "Maximum number of lines to read." }),
  ),
});

const writeSchema = Type.Object({
  path: Type.String({
    description: "Workspace-relative path to the file to write.",
  }),
  content: Type.String({ description: "New full file contents." }),
});

const editEntrySchema = Type.Object({
  old_string: Type.String({
    description:
      "Exact text for one targeted replacement. Must appear in the file (uniquely unless replace_all is set).",
  }),
  new_string: Type.String({ description: "Replacement text for this edit." }),
  replace_all: Type.Optional(
    Type.Boolean({
      description: "When true, replace every occurrence instead of requiring uniqueness.",
    }),
  ),
});

const editSchema = Type.Object({
  path: Type.String({
    description: "Workspace-relative path to the file to edit.",
  }),
  edits: Type.Array(editEntrySchema, {
    description:
      "One or more targeted replacements applied against the original file.",
  }),
});

const lsSchema = Type.Object({
  path: Type.Optional(
    Type.String({
      description: "Directory to list (workspace-relative, default: workspace root).",
    }),
  ),
});

const grepSchema = Type.Object({
  pattern: Type.String({ description: "Search pattern (regex or literal)." }),
  path: Type.Optional(
    Type.String({ description: "Directory or file to search." }),
  ),
  glob: Type.Optional(
    Type.String({ description: "Filter files by glob, e.g. '*.ts'." }),
  ),
  ignoreCase: Type.Optional(
    Type.Boolean({ description: "Case-insensitive search." }),
  ),
  literal: Type.Optional(
    Type.Boolean({ description: "Treat pattern as literal text, not regex." }),
  ),
});

const findSchema = Type.Object({
  pattern: Type.String({
    description: "Glob pattern for file names, e.g. '*.docx'.",
  }),
  path: Type.Optional(
    Type.String({ description: "Directory to search (default: workspace root)." }),
  ),
});

const docxToolSchema = Type.Object({
  subcommand: Type.String({
    description:
      "./docx-tool subcommand (e.g. info, refresh, save, replace-text, find-text).",
  }),
  args: Type.Optional(
    Type.Array(Type.String(), {
      description: "Additional arguments to pass after the subcommand.",
    }),
  ),
  stdin: Type.Optional(
    Type.String({ description: "Optional stdin to pipe to the helper." }),
  ),
});

// --- Parity check: typebox (browser) vs zod (server) schemas --------------
// The model sees the typebox shape; the server validates with zod. If these
// drift, we want to fail loudly at module load, not at runtime in prod.
// Server-only fields like `workspaceId` are injected by `makeExecute`, so we
// allow them to exist on the zod side without a typebox mirror.

const SERVER_ONLY_KEYS = new Set(["workspaceId"]);

interface TypeBoxObjectLike {
  properties?: Record<string, unknown>;
}

function typeboxKeys(schema: unknown): string[] {
  const props = (schema as TypeBoxObjectLike).properties;
  return props ? Object.keys(props) : [];
}

function zodKeys(schema: ZodObject<ZodRawShape>): string[] {
  return Object.keys(schema.shape);
}

function assertSchemaParity(
  toolName: string,
  typebox: unknown,
  zod: ZodObject<ZodRawShape>,
): void {
  const tbKeys = new Set(typeboxKeys(typebox));
  const zodAll = new Set(zodKeys(zod));
  const zodUserFacing = new Set(
    [...zodAll].filter((k) => !SERVER_ONLY_KEYS.has(k)),
  );

  const missingInTypebox = [...zodUserFacing].filter((k) => !tbKeys.has(k));
  const extraInTypebox = [...tbKeys].filter((k) => !zodAll.has(k));

  if (missingInTypebox.length > 0 || extraInTypebox.length > 0) {
    const parts: string[] = [];
    if (missingInTypebox.length > 0) {
      parts.push(`missing in typebox: [${missingInTypebox.join(", ")}]`);
    }
    if (extraInTypebox.length > 0) {
      parts.push(`extra in typebox: [${extraInTypebox.join(", ")}]`);
    }
    throw new Error(
      `[tools] schema parity mismatch for "${toolName}" — ${parts.join("; ")}`,
    );
  }
}

// Run once at module load so mismatches surface as soon as the bundle boots.
assertSchemaParity("bash", bashSchema, bashArgsSchema);
assertSchemaParity("read", readSchema, readArgsSchema);
assertSchemaParity("write", writeSchema, writeArgsSchema);
assertSchemaParity("edit", editSchema, editArgsSchema);
assertSchemaParity("ls", lsSchema, lsArgsSchema);
assertSchemaParity("grep", grepSchema, grepArgsSchema);
assertSchemaParity("find", findSchema, findArgsSchema);
assertSchemaParity("docx_tool", docxToolSchema, docxToolArgsSchema);

export function createLocalTools(workspaceId: string): AgentTool<any>[] {
  const bashTool: AgentTool<typeof bashSchema> = {
    name: "bash",
    label: "bash",
    description:
      "Execute a bash command inside the workspace. Returns stdout and stderr. Use for running the ./docx-tool helper and other workspace-local commands.",
    parameters: bashSchema,
    execute: makeExecute("bash", workspaceId),
  };

  const readTool: AgentTool<typeof readSchema> = {
    name: "read",
    label: "read",
    description:
      "Read the contents of a workspace text file. Use offset/limit for large files.",
    parameters: readSchema,
    execute: makeExecute("read", workspaceId),
  };

  const writeTool: AgentTool<typeof writeSchema> = {
    name: "write",
    label: "write",
    description:
      "Write a text file inside the workspace, creating or overwriting it.",
    parameters: writeSchema,
    execute: makeExecute("write", workspaceId),
  };

  const editTool: AgentTool<typeof editSchema> = {
    name: "edit",
    label: "edit",
    description:
      "Apply one or more exact-text replacements to a workspace file. Each edit targets the original file content; unique matches are required unless replace_all is set.",
    parameters: editSchema,
    execute: makeExecute("edit", workspaceId),
  };

  const lsTool: AgentTool<typeof lsSchema> = {
    name: "ls",
    label: "ls",
    description:
      "List directory contents inside the workspace, sorted alphabetically.",
    parameters: lsSchema,
    execute: makeExecute("ls", workspaceId),
  };

  const grepTool: AgentTool<typeof grepSchema> = {
    name: "grep",
    label: "grep",
    description:
      "Search file contents for a pattern inside the workspace, returning matches with file paths and line numbers.",
    parameters: grepSchema,
    execute: makeExecute("grep", workspaceId),
  };

  const findTool: AgentTool<typeof findSchema> = {
    name: "find",
    label: "find",
    description:
      "Search for files by glob pattern inside the workspace. Returns matching paths relative to the search directory.",
    parameters: findSchema,
    execute: makeExecute("find", workspaceId),
  };

  // The tool the LLM sees uses an underscore so it survives strict tool-name
  // validation across providers; the server route is still /api/tools/docx-tool.
  const docxTool: AgentTool<typeof docxToolSchema> = {
    name: "docx_tool",
    label: "docx-tool",
    description:
      "Run a subcommand of the workspace-local ./docx-tool helper (info, refresh, save, text, structure, replace-text, find-text, insert-after, append-paragraph, form-field helpers, get-ooxml, insert-ooxml, execute-stdin, execute-file, etc.).",
    parameters: docxToolSchema,
    execute: makeExecute("docx-tool", workspaceId),
  };

  return [
    bashTool,
    readTool,
    writeTool,
    editTool,
    lsTool,
    grepTool,
    findTool,
    docxTool,
  ];
}
