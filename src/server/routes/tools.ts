import { Hono } from "hono";
import type { Context } from "hono";
import type { ZodSchema } from "zod";
import { ZodError } from "zod";
import {
  bashArgsSchema,
  docxToolArgsSchema,
  editArgsSchema,
  findArgsSchema,
  grepArgsSchema,
  lsArgsSchema,
  readArgsSchema,
  writeArgsSchema,
} from "../../lib/tool-schemas";
import { appendActivity } from "../activity";
import { getWorkspace } from "../workspace";
import type { Workspace } from "../workspace";
import { SandboxEscapeError } from "../sandbox";
import { runBash } from "../tools/bash";
import { runDocxTool } from "../tools/docx-tool";
import { editFile, listDir, readFile, writeFile } from "../tools/fs";
import { find, grep } from "../tools/search";

export const toolsRouter = new Hono();

interface ErrorResponse {
  ok: false;
  error: string;
}

interface SuccessResponse<T> {
  ok: true;
  result: T;
}

function errorBody(error: string): ErrorResponse {
  return { ok: false, error };
}

function successBody<T>(result: T): SuccessResponse<T> {
  return { ok: true, result };
}

/**
 * Parses+validates the request body with a zod schema and loads the
 * workspace. Returns either a short-circuit `Response` (400/404) or the
 * validated args + workspace.
 */
async function parseAndLoad<TSchema extends ZodSchema>(
  c: Context,
  schema: TSchema,
): Promise<
  | { ok: true; args: import("zod").infer<TSchema>; workspace: Workspace }
  | { ok: false; response: Response }
> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return {
      ok: false,
      response: c.json(errorBody("invalid JSON body"), 400),
    };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const message = issue
      ? `${issue.path.join(".") || "body"}: ${issue.message}`
      : "validation failed";
    return {
      ok: false,
      response: c.json(errorBody(message), 400),
    };
  }
  const workspaceId = (parsed.data as { workspaceId: string }).workspaceId;
  const workspace = await getWorkspace(workspaceId);
  if (!workspace) {
    return {
      ok: false,
      response: c.json(errorBody(`unknown workspace: ${workspaceId}`), 404),
    };
  }
  return { ok: true, args: parsed.data, workspace };
}

function mapErrorStatus(err: unknown): 400 | 500 {
  if (err instanceof SandboxEscapeError) return 400;
  if (err instanceof ZodError) return 400;
  return 500;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// ============================================================================
// POST /bash
// ============================================================================
toolsRouter.post("/bash", async (c) => {
  const loaded = await parseAndLoad(c, bashArgsSchema);
  if (!loaded.ok) return loaded.response;
  const { workspace, args } = loaded;
  try {
    const result = await runBash(workspace, {
      command: args.command,
      cwd: args.cwd,
      timeoutMs: args.timeoutMs,
    });
    await appendActivity(workspace.id, {
      type: "tool",
      tool: "bash",
      command: args.command,
      cwd: args.cwd,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      truncated: result.truncated,
      durationMs: result.durationMs,
    });
    return c.json(successBody(result));
  } catch (err) {
    const status = mapErrorStatus(err);
    const message = errorMessage(err);
    await appendActivity(workspace.id, {
      type: "tool_error",
      tool: "bash",
      error: message,
    }).catch(() => undefined);
    return c.json(errorBody(message), status);
  }
});

// ============================================================================
// POST /read
// ============================================================================
toolsRouter.post("/read", async (c) => {
  const loaded = await parseAndLoad(c, readArgsSchema);
  if (!loaded.ok) return loaded.response;
  const { workspace, args } = loaded;
  try {
    const result = await readFile(workspace, {
      path: args.path,
      offset: args.offset,
      limit: args.limit,
    });
    await appendActivity(workspace.id, {
      type: "tool",
      tool: "read",
      path: args.path,
      byteSize: result.byteSize,
      truncated: result.truncated,
    });
    return c.json(successBody(result));
  } catch (err) {
    const status = mapErrorStatus(err);
    const message = errorMessage(err);
    await appendActivity(workspace.id, {
      type: "tool_error",
      tool: "read",
      path: args.path,
      error: message,
    }).catch(() => undefined);
    return c.json(errorBody(message), status);
  }
});

// ============================================================================
// POST /write
// ============================================================================
toolsRouter.post("/write", async (c) => {
  const loaded = await parseAndLoad(c, writeArgsSchema);
  if (!loaded.ok) return loaded.response;
  const { workspace, args } = loaded;
  try {
    const result = await writeFile(workspace, {
      path: args.path,
      content: args.content,
    });
    await appendActivity(workspace.id, {
      type: "tool",
      tool: "write",
      path: args.path,
      bytesWritten: result.bytesWritten,
    });
    return c.json(successBody(result));
  } catch (err) {
    const status = mapErrorStatus(err);
    const message = errorMessage(err);
    await appendActivity(workspace.id, {
      type: "tool_error",
      tool: "write",
      path: args.path,
      error: message,
    }).catch(() => undefined);
    return c.json(errorBody(message), status);
  }
});

// ============================================================================
// POST /edit
// ============================================================================
toolsRouter.post("/edit", async (c) => {
  const loaded = await parseAndLoad(c, editArgsSchema);
  if (!loaded.ok) return loaded.response;
  const { workspace, args } = loaded;
  try {
    const result = await editFile(workspace, {
      path: args.path,
      edits: args.edits,
    });
    await appendActivity(workspace.id, {
      type: "tool",
      tool: "edit",
      path: args.path,
      edits: args.edits.length,
      replacements: result.replacements,
    });
    return c.json(successBody(result));
  } catch (err) {
    const status = mapErrorStatus(err);
    const message = errorMessage(err);
    await appendActivity(workspace.id, {
      type: "tool_error",
      tool: "edit",
      path: args.path,
      error: message,
    }).catch(() => undefined);
    return c.json(errorBody(message), status);
  }
});

// ============================================================================
// POST /ls
// ============================================================================
toolsRouter.post("/ls", async (c) => {
  const loaded = await parseAndLoad(c, lsArgsSchema);
  if (!loaded.ok) return loaded.response;
  const { workspace, args } = loaded;
  try {
    const result = await listDir(workspace, { path: args.path });
    await appendActivity(workspace.id, {
      type: "tool",
      tool: "ls",
      path: args.path ?? ".",
      count: result.entries.length,
    });
    return c.json(successBody(result));
  } catch (err) {
    const status = mapErrorStatus(err);
    const message = errorMessage(err);
    await appendActivity(workspace.id, {
      type: "tool_error",
      tool: "ls",
      path: args.path ?? ".",
      error: message,
    }).catch(() => undefined);
    return c.json(errorBody(message), status);
  }
});

// ============================================================================
// POST /grep
// ============================================================================
toolsRouter.post("/grep", async (c) => {
  const loaded = await parseAndLoad(c, grepArgsSchema);
  if (!loaded.ok) return loaded.response;
  const { workspace, args } = loaded;
  try {
    const result = await grep(workspace, {
      pattern: args.pattern,
      path: args.path,
      glob: args.glob,
      ignoreCase: args.ignoreCase,
      literal: args.literal,
    });
    await appendActivity(workspace.id, {
      type: "tool",
      tool: "grep",
      pattern: args.pattern,
      path: args.path ?? ".",
      matches: result.matches.length,
      truncated: result.truncated,
      backend: result.backend,
    });
    return c.json(successBody(result));
  } catch (err) {
    const status = mapErrorStatus(err);
    const message = errorMessage(err);
    await appendActivity(workspace.id, {
      type: "tool_error",
      tool: "grep",
      pattern: args.pattern,
      error: message,
    }).catch(() => undefined);
    return c.json(errorBody(message), status);
  }
});

// ============================================================================
// POST /find
// ============================================================================
toolsRouter.post("/find", async (c) => {
  const loaded = await parseAndLoad(c, findArgsSchema);
  if (!loaded.ok) return loaded.response;
  const { workspace, args } = loaded;
  try {
    const result = await find(workspace, {
      pattern: args.pattern,
      path: args.path,
    });
    await appendActivity(workspace.id, {
      type: "tool",
      tool: "find",
      pattern: args.pattern,
      path: args.path ?? ".",
      files: result.files.length,
      truncated: result.truncated,
      backend: result.backend,
    });
    return c.json(successBody(result));
  } catch (err) {
    const status = mapErrorStatus(err);
    const message = errorMessage(err);
    await appendActivity(workspace.id, {
      type: "tool_error",
      tool: "find",
      pattern: args.pattern,
      error: message,
    }).catch(() => undefined);
    return c.json(errorBody(message), status);
  }
});

// ============================================================================
// POST /docx-tool
// ============================================================================
toolsRouter.post("/docx-tool", async (c) => {
  const loaded = await parseAndLoad(c, docxToolArgsSchema);
  if (!loaded.ok) return loaded.response;
  const { workspace, args } = loaded;
  try {
    const result = await runDocxTool(workspace, {
      subcommand: args.subcommand,
      args: args.args,
      stdin: args.stdin,
    });
    await appendActivity(workspace.id, {
      type: "tool",
      tool: "docx-tool",
      subcommand: args.subcommand,
      args: args.args ?? [],
      exitCode: result.exitCode,
    });
    return c.json(successBody(result));
  } catch (err) {
    const status = mapErrorStatus(err);
    const message = errorMessage(err);
    await appendActivity(workspace.id, {
      type: "tool_error",
      tool: "docx-tool",
      subcommand: args.subcommand,
      error: message,
    }).catch(() => undefined);
    return c.json(errorBody(message), status);
  }
});
