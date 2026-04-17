import { spawn } from "node:child_process";
import path from "node:path";
import { resolveWithinWorkspaceReal } from "../sandbox";
import type { Workspace } from "../workspace";

export interface BashArgs {
  command: string;
  cwd?: string;
  timeoutMs?: number;
}

export interface BashResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_STREAM_BYTES = 200 * 1024; // 200 KB per stream
const TRUNCATION_SUFFIX = "\n[... truncated ...]";

export async function runBash(
  workspace: Workspace,
  args: BashArgs,
): Promise<BashResult> {
  const timeoutMs = Math.min(
    Math.max(args.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1),
    MAX_TIMEOUT_MS,
  );

  // Default cwd to the workspace dir; if a caller supplies `cwd`, it must
  // resolve inside the workspace. This also catches absolute-path cwd.
  let cwd = workspace.dir;
  if (args.cwd && args.cwd.length > 0 && args.cwd !== ".") {
    cwd = await resolveWithinWorkspaceReal(workspace.dir, args.cwd);
  }

  const startedAt = Date.now();

  return await new Promise<BashResult>((resolve) => {
    const child = spawn("bash", ["-lc", args.command], {
      cwd,
      env: {
        ...process.env,
        // Keep cwd locked even if the command cds around.
        PI_DOCX_WORKSPACE_DIR: workspace.dir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutLen = 0;
    let stderrLen = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let finished = false;

    const appendChunk = (
      chunk: Buffer,
      target: Buffer[],
      lenRef: { len: number; truncated: boolean },
    ) => {
      if (lenRef.truncated) return;
      const remaining = MAX_STREAM_BYTES - lenRef.len;
      if (remaining <= 0) {
        lenRef.truncated = true;
        return;
      }
      if (chunk.length <= remaining) {
        target.push(chunk);
        lenRef.len += chunk.length;
      } else {
        target.push(chunk.subarray(0, remaining));
        lenRef.len = MAX_STREAM_BYTES;
        lenRef.truncated = true;
      }
    };

    const stdoutState = { len: 0, truncated: false };
    const stderrState = { len: 0, truncated: false };

    child.stdout.on("data", (chunk: Buffer) => {
      appendChunk(chunk, stdoutChunks, stdoutState);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      appendChunk(chunk, stderrChunks, stderrState);
    });

    const timer = setTimeout(() => {
      if (finished) return;
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
      // Force-kill shortly after if still running.
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }, 2_000).unref?.();
    }, timeoutMs);
    timer.unref?.();

    const onDone = (code: number) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      stdoutTruncated = stdoutState.truncated;
      stderrTruncated = stderrState.truncated;

      let stdout = Buffer.concat(stdoutChunks).toString("utf-8");
      let stderr = Buffer.concat(stderrChunks).toString("utf-8");
      if (stdoutTruncated) stdout += TRUNCATION_SUFFIX;
      if (stderrTruncated) stderr += TRUNCATION_SUFFIX;

      resolve({
        stdout,
        stderr,
        exitCode: code,
        timedOut,
        truncated: stdoutTruncated || stderrTruncated,
        durationMs: Date.now() - startedAt,
      });
    };

    child.on("error", (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      const message = err instanceof Error ? err.message : String(err);
      resolve({
        stdout: "",
        stderr: `bash spawn error: ${message}`,
        exitCode: -1,
        timedOut: false,
        truncated: false,
        durationMs: Date.now() - startedAt,
      });
    });

    child.on("close", (code) => {
      onDone(typeof code === "number" ? code : timedOut ? 124 : 1);
    });
  });
}

// Expose cwd-within-workspace helper for callers that need it (e.g. tests).
export function resolveCwd(workspace: Workspace, cwd?: string): string {
  if (!cwd || cwd === ".") return workspace.dir;
  return path.resolve(workspace.dir, cwd);
}
