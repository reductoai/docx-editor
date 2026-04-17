import { chmod, copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const WORKSPACES_ROOT = path.join(process.cwd(), "workspaces");

export interface Workspace {
  id: string;
  dir: string;
  originalPath: string;
  workingPath: string;
  createdAt: string;
  originalName: string;
}

// Validate workspace ids so we never resolve user input into a filesystem path
// without it matching our known shape: YYYY-MM-DD_<uuid-ish>.
const WORKSPACE_ID_RE =
  /^\d{4}-\d{2}-\d{2}_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export function isValidWorkspaceId(id: string): boolean {
  return typeof id === "string" && WORKSPACE_ID_RE.test(id);
}

// Turn-state flag — flipped on/off by Unit 6 to tell the PUT /:id/doc handler
// that the agent is mid-turn and direct document overwrites should 409.
const turnState = new Map<string, boolean>();

export function setTurnState(id: string, active: boolean): void {
  if (!isValidWorkspaceId(id)) return;
  if (active) {
    turnState.set(id, true);
  } else {
    turnState.delete(id);
  }
}

export function isTurnActive(id: string): boolean {
  return turnState.get(id) === true;
}

function formatDateSegment(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function buildWorkspaceId(date: Date = new Date()): string {
  return `${formatDateSegment(date)}_${randomUUID()}`;
}

/**
 * Safely resolves a workspace-relative path. Throws on:
 *   - invalid workspace id shape
 *   - absolute input paths
 *   - any `..` traversal that escapes the workspace dir
 */
export function resolveWithinWorkspace(id: string, relPath: string): string {
  if (!isValidWorkspaceId(id)) {
    throw new Error(`Invalid workspace id: ${id}`);
  }
  if (typeof relPath !== "string" || relPath.length === 0) {
    throw new Error("Relative path is required.");
  }
  if (path.isAbsolute(relPath)) {
    throw new Error(`Refusing absolute path: ${relPath}`);
  }
  const workspaceDir = path.resolve(WORKSPACES_ROOT, id);
  const resolved = path.resolve(workspaceDir, relPath);
  const prefix = workspaceDir + path.sep;
  if (resolved !== workspaceDir && !resolved.startsWith(prefix)) {
    throw new Error(
      `Refusing path traversal outside workspace: ${relPath} resolved to ${resolved}`,
    );
  }
  return resolved;
}

async function readMetadata(
  workspaceDir: string,
): Promise<{ createdAt: string; originalName: string } | null> {
  const metadataPath = path.join(workspaceDir, "metadata.json");
  try {
    const raw = await readFile(metadataPath, "utf-8");
    const parsed = JSON.parse(raw) as {
      createdAt?: unknown;
      originalName?: unknown;
    };
    return {
      createdAt:
        typeof parsed.createdAt === "string"
          ? parsed.createdAt
          : new Date().toISOString(),
      originalName:
        typeof parsed.originalName === "string"
          ? parsed.originalName
          : "document.docx",
    };
  } catch {
    return null;
  }
}

export async function getWorkspace(id: string): Promise<Workspace | null> {
  if (!isValidWorkspaceId(id)) return null;
  const dir = path.join(WORKSPACES_ROOT, id);
  try {
    const stats = await stat(dir);
    if (!stats.isDirectory()) return null;
  } catch {
    return null;
  }
  const metadata = (await readMetadata(dir)) ?? {
    createdAt: new Date().toISOString(),
    originalName: "document.docx",
  };
  return {
    id,
    dir,
    originalPath: path.join(dir, "original.docx"),
    workingPath: path.join(dir, "working.docx"),
    createdAt: metadata.createdAt,
    originalName: metadata.originalName,
  };
}

export async function createWorkspace(opts: {
  file: File;
  originalName: string;
}): Promise<Workspace> {
  const { file, originalName } = opts;
  const createdAt = new Date();
  const id = buildWorkspaceId(createdAt);
  const dir = path.join(WORKSPACES_ROOT, id);
  await mkdir(dir, { recursive: true });

  // Write original + working side-by-side.
  const bytes = Buffer.from(await file.arrayBuffer());
  const originalPath = path.join(dir, "original.docx");
  const workingPath = path.join(dir, "working.docx");
  await writeFile(originalPath, bytes);
  await writeFile(workingPath, bytes);

  // Metadata.
  const metadata = {
    createdAt: createdAt.toISOString(),
    originalName,
  };
  await writeFile(
    path.join(dir, "metadata.json"),
    JSON.stringify(metadata, null, 2),
  );

  // Ensure activity dir exists so appends don't race the mkdir later.
  await mkdir(path.join(dir, "activity"), { recursive: true });

  const workspace: Workspace = {
    id,
    dir,
    originalPath,
    workingPath,
    createdAt: metadata.createdAt,
    originalName,
  };

  await seedWorkspace(workspace);
  return workspace;
}

// =============================================================================
// Workspace seeding (ported from reference/src/pi_docx_editor/agent.ts:
// prepareAgentWorkspace). The reference writes these files inline so this
// repo stays self-contained.
// =============================================================================

const README_AGENT = [
  "# Agent Workspace",
  "",
  "Read HEADLESS_WORD_SKILL.md before making structural or formatting-sensitive edits.",
  "",
  "Use these commands from the workspace root:",
  "",
  "```bash",
  "./docx-tool info",
  "./docx-tool text --out document_text.current.json",
  "./docx-tool structure --out document_structure.current.json",
  "./docx-tool refresh",
  "./docx-tool get-ooxml --start-child 10 --end-child 12 --out ooxml.json",
  "./docx-tool insert-ooxml --file snippet.xml --position after:12",
  "./docx-tool find-text --text 'Clause 4'",
  "./docx-tool replace-text --old 'Old text' --new 'New text'",
  "./docx-tool replace-all-text --old 'Old text' --new 'New text'",
  "./docx-tool delete-text --text 'Text to remove'",
  "./docx-tool delete-all-text --text 'Text to remove'",
  "./docx-tool list-form-fields",
  "./docx-tool set-form-field --name Text1 --text 'Updated value'",
  "./docx-tool fill-form-fields --by default --mapping replacements.json",
  "./docx-tool flatten-form-fields",
  "./docx-tool execute-stdin <<'PY'",
  "from com.sun.star.awt.FontWeight import BOLD",
  "result = {'ok': True}",
  "PY",
  "./docx-tool append-paragraph --text 'New paragraph'",
  "./docx-tool accept-all-changes",
  "./docx-tool reject-all-changes",
  "./docx-tool insert-after --anchor 'Existing paragraph text' --text 'Inserted paragraph'",
  "./docx-tool save",
  "```",
  "",
  "Guidelines:",
  "- Read document_text.current.json and document_structure.current.json before editing.",
  "- Prefer helper commands over raw Python execution, but use execute-stdin or execute-file when you need formatting or UNO-level edits that helper commands do not expose.",
  "- Use list-form-fields before filling or flattening legacy Word form fields.",
  "- set-form-field, fill-form-fields, and flatten-form-fields replace legacy form fields with plain text and reopen the workspace session automatically.",
  "- Use ./docx-tool find-text when target text or anchor paragraphs may appear more than once.",
  "- Use ./docx-tool get-ooxml to inspect exact body-child indices before structural OOXML insertion.",
  "- Use ./docx-tool insert-ooxml only when helper-level paragraph or form-field commands are insufficient.",
  "- Formatting edits like bold/italic/font size/color are supported via ./docx-tool execute-stdin or execute-file using the provided UNO context.",
  "- In execute scripts, use doc/text/cursor/uno/smgr/ctx directly and do not rely on XSCRIPTCONTEXT.",
  "- For small boundary edits such as adding/removing a prefix or suffix, prefer a minimal insertion/deletion approach over replacing the whole paragraph text.",
  "- replace-text/delete-text require a unique exact match and fail on ambiguity.",
  "- replace-all-text/delete-all-text should only be used when every exact occurrence should change.",
  "- insert-after requires a unique exact anchor paragraph and fails on ambiguity.",
  "- Do not use accept-all-changes or reject-all-changes unless the user explicitly asks to confirm, accept, reject, or resolve tracked changes.",
  "- After changing the document, run ./docx-tool refresh and then ./docx-tool save.",
  "- Update agent_notes.md before you finish.",
].join("\n");

const HEADLESS_WORD_SKILL = [
  "# Headless Word Skill Notes",
  "",
  "These are distilled usage notes for this workspace's DOCX runtime and helper wrapper.",
  "",
  "## Core workflow",
  "- Read before writing.",
  "- Start with document_structure.current.json and document_text.current.json.",
  "- Use ./docx-tool get-ooxml only when exact body-child structure, paragraph/list properties, or run formatting matters.",
  "- Do not dump full OOXML into context; inspect narrow ranges and specific lines only.",
  "",
  "## Tool choice",
  "- Prefer ./docx-tool replace-text, replace-all-text, delete-text, delete-all-text, insert-after, append-paragraph, and form-field helpers for ordinary edits.",
  "- Use ./docx-tool execute-stdin or execute-file for formatting changes, UNO-level range edits, comments, tables, and other edits the helper commands do not expose.",
  "- In execute scripts, the runtime already provides doc, text, cursor, uno, smgr, and ctx. Do not assume XSCRIPTCONTEXT exists.",
  "- Prefer OOXML insertion only for structure-preserving insertion that helper commands or normal UNO edits cannot safely express.",
  "",
  "## Formatting preservation",
  "- Plain text replacement of existing formatted Word content can destroy direct run formatting.",
  "- Formatting changes themselves are supported. If you need bold, italic, font size, color, alignment, spacing, or similar styling changes, use UNO through execute-stdin/execute-file unless a higher-level helper already exists.",
  "- Legacy Word form-field result text can often be formatted through UNO because the displayed text still exists as document text/runs.",
  "- If existing formatting seems important, inspect nearby OOXML first and preserve relevant <w:rPr> and <w:pPr> structure.",
  "- If a paragraph is a real list paragraph, preserve its numbering structure. Do not fake bullets or numbering by prefixing text manually.",
  "- Match nearby fonts, size, color, spacing, and alignment instead of guessing.",
  "",
  "## Minimal tracked changes",
  "- Prefer the smallest possible edit region.",
  "- If the request is to add or remove a few characters at the start or end of an existing paragraph, do not replace the entire paragraph text.",
  "- Prefer exact boundary insertion/deletion so tracked changes show only the changed characters instead of striking through and re-adding the full line.",
  "- Treat paragraph-wide rewrites as a last resort unless the whole paragraph content actually needs to change.",
  "",
  "## OOXML notes",
  "- Body children are direct elements under <w:body> like paragraphs, tables, content controls, and sectPr.",
  "- insert-ooxml positions are start, end, or after:<body_child_index>.",
  '- When text has leading or trailing spaces in OOXML, preserve them with xml:space="preserve".',
  "- For paragraph properties, element order matters; do not casually reorder copied OOXML.",
  "",
  "## Complex edit strategy",
  "- Build incrementally.",
  "- For formatting-sensitive or structural edits: inspect -> edit narrowly -> refresh -> save -> verify.",
  "- Leave tracked changes enabled unless the user explicitly asks to resolve them.",
].join("\n");

const AGENT_NOTES_TEMPLATE = ["# Agent Notes", "", "- Pending."].join("\n");

function buildDocxToolScript(workspace: Workspace, helperPythonPath: string): string {
  const sessionStatePath = path.join(workspace.dir, "headless_word_session.json");
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `export PI_DOCX_WORKSPACE_DIR=${JSON.stringify(workspace.dir)}`,
    `export PI_DOCX_WORKING_DOCX_PATH=${JSON.stringify(workspace.workingPath)}`,
    `export PI_DOCX_SESSION_STATE_PATH=${JSON.stringify(sessionStatePath)}`,
    'export HEADLESS_WORD_IDLE_TIMEOUT=${HEADLESS_WORD_IDLE_TIMEOUT:-14400}',
    'export PATH="$HOME/.local/bin:$PATH"',
    `python3 ${JSON.stringify(helperPythonPath)} --workspace . "$@"`,
    "",
  ].join("\n");
}

/**
 * Seeds a freshly created workspace with the docx-tool shim, README, skill
 * notes, and placeholder agent_notes. Safe to re-run (idempotent).
 */
export async function seedWorkspace(ws: Workspace): Promise<void> {
  const helperPythonPath = path.join(process.cwd(), "workspace_tool.py");
  const helperScriptPath = path.join(ws.dir, "docx-tool");
  const readmePath = path.join(ws.dir, "README_AGENT.md");
  const skillPath = path.join(ws.dir, "HEADLESS_WORD_SKILL.md");
  const notesPath = path.join(ws.dir, "agent_notes.md");

  await Promise.all([
    writeFile(helperScriptPath, buildDocxToolScript(ws, helperPythonPath), {
      mode: 0o755,
    }),
    writeFile(readmePath, README_AGENT),
    writeFile(skillPath, HEADLESS_WORD_SKILL),
    writeFile(notesPath, AGENT_NOTES_TEMPLATE),
  ]);
  await chmod(helperScriptPath, 0o755).catch(() => undefined);
}

// Re-export copyFile for callers that want to snapshot the working doc.
export { copyFile };
