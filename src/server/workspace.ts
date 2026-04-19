import { chmod, copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  closeSession,
  ensureDaemonRunning,
  getDocumentStructure,
  getDocumentText,
  listSessions,
  openSession,
  setLibreOfficeAuthor,
} from "./headless-word";
import { sanitizeDocxFile } from "./ooxml-sanitize";

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
  const workspace: Workspace = {
    id,
    dir,
    originalPath: path.join(dir, "original.docx"),
    workingPath: path.join(dir, "working.docx"),
    createdAt: metadata.createdAt,
    originalName: metadata.originalName,
  };
  // Self-heal: if the shim is out of date or any seeded file is missing,
  // rewrite them so the agent isn't fighting stale scaffolding.
  await ensureSeedFreshness(workspace).catch((err) => {
    console.warn(
      `[workspace] ensureSeedFreshness failed for ${id}:`,
      (err as Error).message,
    );
  });
  return workspace;
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

  // Strip LibreOffice round-trip artifacts (numPr w:numId=0 on Title
  // paragraphs, etc.) from the working copy before the browser first
  // loads it — otherwise the user's initial render is the unsanitized
  // upload, and SuperDoc collapses title paragraphs. This is idempotent
  // for files that don't have those artifacts.
  await sanitizeDocxFile(workingPath).catch((err) => {
    console.warn(
      `[workspace] initial sanitize failed for ${id}:`,
      (err as Error).message,
    );
  });

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

export const README_AGENT = [
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

export const HEADLESS_WORD_SKILL = [
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
    `export PI_DOCX_SESSION_ID=${JSON.stringify(workspace.id)}`,
    'export HEADLESS_WORD_IDLE_TIMEOUT=${HEADLESS_WORD_IDLE_TIMEOUT:-14400}',
    'export PATH="$HOME/.local/bin:$PATH"',
    // workspace_tool.py has no `--workspace` flag — the workspace dir is
    // picked up from PI_DOCX_WORKSPACE_DIR. Passing `.` as a positional
    // confused argparse and broke every docx-tool invocation.
    `python3 ${JSON.stringify(helperPythonPath)} "$@"`,
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
  const manifestPath = path.join(ws.dir, "workspace_manifest.json");
  const sessionStatePath = path.join(ws.dir, "headless_word_session.json");
  const docTextPath = path.join(ws.dir, "document_text.current.json");
  const docStructPath = path.join(ws.dir, "document_structure.current.json");

  // The system prompt tells the agent to read these before editing. The docx
  // text / structure snapshots are populated by headless-word via
  // `./docx-tool refresh` when the agent runs — seed empty placeholders so
  // the first `read` doesn't ENOENT.
  const manifest = {
    workspaceId: ws.id,
    createdAt: ws.createdAt,
    originalName: ws.originalName,
    sessionId: ws.id,
    paths: {
      workingDocx: "working.docx",
      originalDocx: "original.docx",
      documentText: "document_text.current.json",
      documentStructure: "document_structure.current.json",
    },
  };

  const emptyTextSnapshot = {
    stale: true,
    note: "Run ./docx-tool refresh to populate this file from the current working.docx.",
  };

  // Don't preseed the session file with a placeholder id — the real
  // headless-word session id is written by `ensureHeadlessSession` on the
  // first getWorkspace() hit. A placeholder would be treated as "already
  // valid" by checkpoint.ts and skip the real open.
  await Promise.all([
    writeFile(helperScriptPath, buildDocxToolScript(ws, helperPythonPath), {
      mode: 0o755,
    }),
    writeFile(readmePath, README_AGENT),
    writeFile(skillPath, HEADLESS_WORD_SKILL),
    writeFile(notesPath, AGENT_NOTES_TEMPLATE),
    writeFile(manifestPath, JSON.stringify(manifest, null, 2)),
    writeFile(docTextPath, JSON.stringify(emptyTextSnapshot, null, 2)),
    writeFile(docStructPath, JSON.stringify(emptyTextSnapshot, null, 2)),
  ]);
  await chmod(helperScriptPath, 0o755).catch(() => undefined);
}

/**
 * Re-seeds the workspace scaffolding (shim + docs + snapshots) if any of the
 * required files are missing or the shim is out of date. Safe to call on
 * every `getWorkspace` hit — writes only what's needed.
 */
export async function ensureSeedFreshness(ws: Workspace): Promise<void> {
  const shimPath = path.join(ws.dir, "docx-tool");
  const expectedShim = buildDocxToolScript(
    ws,
    path.join(process.cwd(), "workspace_tool.py"),
  );
  let reseed = false;
  try {
    const existing = await readFile(shimPath, "utf-8");
    if (existing !== expectedShim) reseed = true;
  } catch {
    reseed = true;
  }
  if (!reseed) {
    // Also check the other required files. If any are missing, reseed.
    const required = [
      "README_AGENT.md",
      "HEADLESS_WORD_SKILL.md",
      "agent_notes.md",
      "workspace_manifest.json",
      "headless_word_session.json",
      "document_text.current.json",
      "document_structure.current.json",
    ];
    for (const f of required) {
      try {
        await stat(path.join(ws.dir, f));
      } catch {
        reseed = true;
        break;
      }
    }
  }
  if (reseed) {
    await seedWorkspace(ws);
  }
  // Ensure headless-word has a live session open on this workspace so
  // docx-tool helpers (text / structure / replace / etc.) resolve a real
  // session id from headless_word_session.json.
  await ensureHeadlessSession(ws).catch((err) => {
    console.warn(
      `[workspace] ensureHeadlessSession failed for ${ws.id}:`,
      (err as Error).message,
    );
  });
}

/**
 * Ensures `headless-word` is running and has a session open on this
 * workspace's working.docx. Writes the real session id into
 * `headless_word_session.json` so `workspace_tool.py` picks it up.
 */
async function ensureHeadlessSession(ws: Workspace): Promise<void> {
  await ensureDaemonRunning();

  const sessionFile = path.join(ws.dir, "headless_word_session.json");
  let storedId: string | null = null;
  try {
    const raw = await readFile(sessionFile, "utf-8");
    const parsed = JSON.parse(raw) as { session_id?: unknown };
    if (typeof parsed.session_id === "string" && parsed.session_id.trim()) {
      storedId = parsed.session_id.trim();
    }
  } catch {
    storedId = null;
  }

  // A stored id is only valid if headless-word still tracks it AND it points
  // at this workspace's working.docx. Workspace-id-shaped ids (e.g. the
  // placeholder we previously wrote) will never match a real session.
  const sessions = await listSessions();
  const match =
    storedId && sessions[storedId]?.path === ws.workingPath ? storedId : null;

  // Close any leaked sessions pointing at this working.docx so we don't
  // accumulate ghosts across hot-reloads or crashed previous runs.
  const leaked = Object.entries(sessions)
    .filter(([id, meta]) => id !== match && meta?.path === ws.workingPath)
    .map(([id]) => id);
  for (const id of leaked) {
    await closeSession(id).catch(() => undefined);
  }

  if (match) {
    await ensureAgentAuthorConfigured(match);
    return;
  }

  const freshId = await openSession(ws.workingPath);
  await writeFile(
    sessionFile,
    JSON.stringify({ session_id: freshId }, null, 2),
  );
  await ensureAgentAuthorConfigured(freshId);
}

// LibreOffice's UserProfile is process-wide — once we've set it on the
// running daemon, every tracked-change insertion picks up the name. Retry
// each server boot in case the daemon was restarted under us.
let agentAuthorConfigured = false;

async function ensureAgentAuthorConfigured(sessionId: string): Promise<void> {
  if (agentAuthorConfigured) return;
  try {
    await setLibreOfficeAuthor(sessionId, "Reducto", "Agent");
    agentAuthorConfigured = true;
  } catch (err) {
    console.warn(
      "[workspace] failed to set LibreOffice user profile:",
      (err as Error).message,
    );
  }
}

// Re-export copyFile for callers that want to snapshot the working doc.
export { copyFile };

/**
 * Snapshot files that should be re-generated from the live headless-word
 * session on every read, so the agent never sees `{stale: true}` placeholders.
 */
export const AUTO_REFRESH_SNAPSHOT_FILES = new Set([
  "document_text.current.json",
  "document_structure.current.json",
]);

/**
 * Reads the current (freshly-refreshed) document text snapshot. Used to
 * inline document state into the agent's system prompt at turn start, so
 * the agent doesn't burn three parallel tool calls on README / SKILL /
 * document_text reads at the top of every turn.
 */
export async function loadCurrentDocumentText(ws: Workspace): Promise<string | null> {
  try {
    return await readFile(
      path.join(ws.dir, "document_text.current.json"),
      "utf-8",
    );
  } catch {
    return null;
  }
}

/**
 * Re-generates `document_text.current.json` and `document_structure.current.json`
 * from the current headless-word session state. Called just-in-time by the
 * `read` tool when the agent asks for one of those files, so reads are always
 * fresh without the agent having to run `./docx-tool refresh` first.
 *
 * Safe to call concurrently for the same workspace: concurrent refreshes just
 * write the same bytes. If the session can't be resolved we leave the file as
 * is (previous snapshot or seeded placeholder) rather than failing the read.
 */
export async function refreshDocumentSnapshots(
  ws: Workspace,
): Promise<void> {
  const sessionFile = path.join(ws.dir, "headless_word_session.json");
  let sessionId: string | null = null;
  try {
    const raw = await readFile(sessionFile, "utf-8");
    const parsed = JSON.parse(raw) as { session_id?: unknown };
    if (typeof parsed.session_id === "string" && parsed.session_id.trim()) {
      const id = parsed.session_id.trim();
      // Reject stale placeholders (we used to write the workspace id here).
      if (id !== ws.id) sessionId = id;
    }
  } catch {
    sessionId = null;
  }
  if (!sessionId) return;

  const sessions = await listSessions();
  if (!sessions[sessionId]) return;

  const [textPayload, structurePayload] = await Promise.all([
    getDocumentText(sessionId),
    getDocumentStructure(sessionId),
  ]);
  await Promise.all([
    writeFile(
      path.join(ws.dir, "document_text.current.json"),
      JSON.stringify(textPayload, null, 2),
    ),
    writeFile(
      path.join(ws.dir, "document_structure.current.json"),
      JSON.stringify(structurePayload, null, 2),
    ),
  ]);
}
