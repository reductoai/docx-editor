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
 * Saves the session's document state to a temporary file then reads back the
 * bytes. The headless-word `save` command writes the DOCX to disk; its JSON
 * reply contains the path. We round-trip through disk so we always hand
 * callers fully-normalized DOCX bytes.
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
