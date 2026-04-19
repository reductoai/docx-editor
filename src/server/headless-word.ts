import { spawn } from "node:child_process";
import { access, readFile, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

export type SessionId = string;

interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface RunOptions {
  timeoutMs?: number;
  input?: string;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const PATH_ENV = `${path.join(homedir(), ".local", "bin")}:${
  process.env["PATH"] ?? ""
}`;

let headlessWordBinary: string | null = null;
let resolvePromise: Promise<string> | null = null;

function buildEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: PATH_ENV,
  };
}

async function findExecutable(name: string): Promise<string | null> {
  const candidates = PATH_ENV.split(":")
    .filter((entry) => entry.length > 0)
    .map((entry) => path.join(entry, name));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // keep searching
    }
  }
  return null;
}

async function resolveHeadlessWord(): Promise<string> {
  if (headlessWordBinary) return headlessWordBinary;
  if (!resolvePromise) {
    resolvePromise = (async () => {
      const found = await findExecutable("headless-word");
      if (!found) {
        throw new Error(
          "headless-word CLI not found on PATH. Install with `uv tool install headless-word` (see docs) or add it to PATH.",
        );
      }
      headlessWordBinary = found;
      return found;
    })().catch((err) => {
      resolvePromise = null;
      throw err;
    });
  }
  return resolvePromise;
}

function runProcess(
  command: string,
  args: string[],
  options: RunOptions = {},
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: buildEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let finished = false;

    const timeout = setTimeout(() => {
      if (finished) return;
      finished = true;
      child.kill("SIGTERM");
      reject(
        new Error(
          `headless-word timed out after ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms: ${command} ${args.join(" ")}`,
        ),
      );
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    child.stdout.on("data", (chunk: string | Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: string | Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      reject(err);
    });
    child.on("close", (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      resolve({ code: code ?? 1, stdout, stderr });
    });

    if (options.input !== undefined) {
      child.stdin.write(options.input);
    }
    child.stdin.end();
  });
}

async function runHeadlessWord(
  args: string[],
  options: RunOptions = {},
): Promise<ProcessResult> {
  const bin = await resolveHeadlessWord();
  const result = await runProcess(bin, args, options);
  if (result.code !== 0) {
    throw new Error(
      `headless-word ${args.join(" ")} failed (exit ${result.code}).\nSTDOUT:\n${result.stdout.trim()}\nSTDERR:\n${result.stderr.trim()}`,
    );
  }
  return result;
}

async function runHeadlessWordJson<T>(
  args: string[],
  options: RunOptions = {},
): Promise<T> {
  const result = await runHeadlessWord(args, options);
  try {
    return JSON.parse(result.stdout) as T;
  } catch (err) {
    throw new Error(
      `Failed to parse JSON output from \`headless-word ${args.join(" ")}\`: ${
        err instanceof Error ? err.message : String(err)
      }\n\nOutput:\n${result.stdout}`,
    );
  }
}

/** Dumps the session's current document text/structure as JSON. */
export async function getDocumentText(sessionId: SessionId): Promise<unknown> {
  return runHeadlessWordJson<unknown>(["get-document-text", sessionId]);
}

/**
 * Returns true iff the session's in-memory document has unsaved edits.
 * Used to gate the checkpoint save — reading docs or running read-only
 * helper subcommands should never round-trip the DOCX through LibreOffice.
 */
export async function isSessionModified(sessionId: SessionId): Promise<boolean> {
  const code = `result = {"modified": bool(doc.isModified())}`;
  try {
    const payload = await runHeadlessWordJson<{ modified?: unknown }>([
      "execute",
      sessionId,
      "--code",
      code,
    ]);
    return payload?.modified === true;
  } catch {
    // If we can't tell, assume modified so we don't miss a real edit.
    return true;
  }
}

/**
 * Writes the LibreOffice user profile (first / last name) so tracked changes
 * made by the agent are attributed to a proper name instead of "Unknown
 * Author". The setting is daemon-wide, so we only need one successful call
 * per daemon lifetime.
 */
export async function setLibreOfficeAuthor(
  sessionId: SessionId,
  firstName: string,
  lastName: string,
): Promise<void> {
  // Escape quotes in the Python string literals.
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const code = `
from com.sun.star.beans import PropertyValue
cfg = smgr.createInstanceWithContext(
    "com.sun.star.configuration.ConfigurationProvider", ctx
)
arg = PropertyValue()
arg.Name = "nodepath"
arg.Value = "/org.openoffice.UserProfile/Data"
# ConfigurationProvider exposes an XMultiServiceFactory; the
# "...AndContext" variant does NOT exist on this service.
writer = cfg.createInstanceWithArguments(
    "com.sun.star.configuration.ConfigurationUpdateAccess",
    (arg,),
)
writer.setPropertyValue("givenname", "${esc(firstName)}")
writer.setPropertyValue("sn", "${esc(lastName)}")
writer.commitChanges()
result = {"author_set": "${esc(firstName)} ${esc(lastName)}"}
`;
  await runHeadlessWordJson<unknown>([
    "execute",
    sessionId,
    "--code",
    code,
  ]);
}

export async function getDocumentStructure(
  sessionId: SessionId,
): Promise<unknown> {
  return runHeadlessWordJson<unknown>(["get-document-structure", sessionId]);
}

/** Opens a DOCX file with headless-word; returns a session id. */
export async function openSession(docxPath: string): Promise<SessionId> {
  const payload = await runHeadlessWordJson<{ session_id: string }>([
    "open",
    docxPath,
  ]);
  if (!payload?.session_id) {
    throw new Error(
      "headless-word open did not return a session_id in its JSON payload.",
    );
  }
  return payload.session_id;
}

/**
 * Ensures the headless-word daemon is running. Idempotent — cheap to call on
 * every workspace hit. `status` exits 0 when the daemon is up.
 */
export async function ensureDaemonRunning(): Promise<void> {
  await resolveHeadlessWord();
  const status = await runProcess(
    headlessWordBinary!,
    ["status"],
    { timeoutMs: 10_000 },
  );
  if (status.code === 0) return;
  // `status` exits non-zero when the daemon isn't up. Start it.
  await runHeadlessWord(["start"], { timeoutMs: 60_000 });
}

/**
 * Returns the active session ids keyed by headless-word id.
 */
export async function listSessions(): Promise<Record<string, { path?: string }>> {
  try {
    return await runHeadlessWordJson<Record<string, { path?: string }>>([
      "list",
    ]);
  } catch {
    return {};
  }
}

/**
 * Saves the session's document in-place to its original path. headless-word's
 * `save <session>` writes the DOCX back to whatever path the session was
 * opened from. This is what we want for checkpoints — the session stays valid
 * and `working.docx` gets the latest bytes.
 *
 * Note: do NOT pass `--path` here. Per `headless-word save --help`, `--path`
 * is a "save-as" operation that re-associates the session with the new path.
 * After a save-as the original session becomes invalid (`SwXTextDocument not
 * valid`) and subsequent `get-document-text` / further edits on that session
 * fail. We learned this the hard way.
 */
export async function saveSessionInPlace(sessionId: SessionId): Promise<void> {
  await runHeadlessWordJson<{ saved: string }>(["save", sessionId]);
}

/**
 * Legacy "save to an out-of-band path and read the bytes back" helper. Kept
 * for any caller that truly needs normalized bytes without affecting the
 * session's on-disk source. Prefer `saveSessionInPlace` for checkpoints.
 */
export async function saveDocument(sessionId: SessionId): Promise<Buffer> {
  const outPath = path.join(
    tmpdir(),
    `docx-editor-save-${Date.now()}-${Math.random().toString(16).slice(2)}.docx`,
  );
  try {
    const payload = await runHeadlessWordJson<{ saved: string }>([
      "save",
      sessionId,
      "--path",
      outPath,
    ]);
    const savedPath = payload?.saved || outPath;
    return await readFile(savedPath);
  } finally {
    // Best-effort cleanup.
    await unlink(outPath).catch(() => undefined);
  }
}

/**
 * Runs a UNO Python snippet inside an existing headless-word session.
 * The code has access to `doc`, `ctx`, `smgr`, and must set `result`.
 */
export async function executeInSession<T = unknown>(
  sessionId: SessionId,
  code: string,
): Promise<T> {
  return runHeadlessWordJson<T>(["execute", sessionId, "--code", code]);
}

export async function closeSession(sessionId: SessionId): Promise<void> {
  try {
    await runHeadlessWord(["close", sessionId]);
  } catch (err) {
    // `close` failures are informational — swallow them so callers can always
    // unwind cleanly after a partial failure.
    console.warn(
      `[headless-word] close(${sessionId}) failed:`,
      (err as Error).message,
    );
  }
}
