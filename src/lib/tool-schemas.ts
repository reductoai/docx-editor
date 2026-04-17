// Shared zod schemas for the tool endpoints. Kept Node-free so the browser
// agent (Unit 6) can import them directly for argument validation.

import { z } from "zod";

// A relative path inside the workspace. We only reject the obvious cases here
// (absolute paths, empty strings); the server-side sandbox resolver does the
// real traversal check.
const relPathSchema = z
  .string()
  .min(1, "path is required")
  .refine((value) => !value.startsWith("/"), {
    message: "path must be workspace-relative (no leading /)",
  });

const workspaceIdSchema = z.string().min(1);

// ---------- bash ----------
export const bashArgsSchema = z.object({
  workspaceId: workspaceIdSchema,
  command: z.string().min(1),
  cwd: z.string().optional(),
  timeoutMs: z.number().int().positive().max(300_000).optional(),
});
export type BashArgsInput = z.infer<typeof bashArgsSchema>;

// ---------- read ----------
export const readArgsSchema = z.object({
  workspaceId: workspaceIdSchema,
  path: relPathSchema,
  offset: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().max(100_000).optional(),
});
export type ReadArgsInput = z.infer<typeof readArgsSchema>;

// ---------- write ----------
export const writeArgsSchema = z.object({
  workspaceId: workspaceIdSchema,
  path: relPathSchema,
  content: z.string(),
});
export type WriteArgsInput = z.infer<typeof writeArgsSchema>;

// ---------- edit ----------
export const editEntrySchema = z.object({
  old_string: z.string().min(1),
  new_string: z.string(),
  replace_all: z.boolean().optional(),
});
export const editArgsSchema = z.object({
  workspaceId: workspaceIdSchema,
  path: relPathSchema,
  edits: z.array(editEntrySchema).min(1),
});
export type EditArgsInput = z.infer<typeof editArgsSchema>;

// ---------- ls ----------
export const lsArgsSchema = z.object({
  workspaceId: workspaceIdSchema,
  path: z.string().min(1).optional(),
});
export type LsArgsInput = z.infer<typeof lsArgsSchema>;

// ---------- grep ----------
export const grepArgsSchema = z.object({
  workspaceId: workspaceIdSchema,
  pattern: z.string().min(1),
  path: z.string().min(1).optional(),
  glob: z.string().optional(),
  ignoreCase: z.boolean().optional(),
  literal: z.boolean().optional(),
});
export type GrepArgsInput = z.infer<typeof grepArgsSchema>;

// ---------- find ----------
export const findArgsSchema = z.object({
  workspaceId: workspaceIdSchema,
  pattern: z.string().min(1),
  path: z.string().min(1).optional(),
});
export type FindArgsInput = z.infer<typeof findArgsSchema>;

// ---------- docx-tool ----------
export const docxToolArgsSchema = z.object({
  workspaceId: workspaceIdSchema,
  subcommand: z.string().min(1),
  args: z.array(z.string()).optional(),
  stdin: z.string().optional(),
});
export type DocxToolArgsInput = z.infer<typeof docxToolArgsSchema>;

// Mutating subcommands — ported from
// reference/src/pi_docx_editor/pipeline.ts:94-109. Used by the server to
// decide when to schedule a checkpoint.
export const MUTATING_DOCX_TOOL_SUBCOMMANDS = [
  "replace-text",
  "replace-all-text",
  "delete-text",
  "delete-all-text",
  "append-paragraph",
  "insert-after",
  "set-form-field",
  "fill-form-fields",
  "flatten-form-fields",
  "accept-all-changes",
  "reject-all-changes",
  "execute-file",
  "execute-stdin",
  "insert-ooxml",
] as const;

export type MutatingDocxToolSubcommand =
  (typeof MUTATING_DOCX_TOOL_SUBCOMMANDS)[number];

export function isMutatingDocxSubcommand(
  subcommand: string,
): subcommand is MutatingDocxToolSubcommand {
  return (MUTATING_DOCX_TOOL_SUBCOMMANDS as readonly string[]).includes(
    subcommand,
  );
}
