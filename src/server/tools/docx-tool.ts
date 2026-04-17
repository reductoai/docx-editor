import { spawn } from "node:child_process";
import path from "node:path";
import { scheduleCheckpoint } from "../checkpoint";
import { isMutatingDocxSubcommand } from "../../lib/tool-schemas";
import type { Workspace } from "../workspace";

export interface DocxToolArgs {
  subcommand: string;
  args?: string[];
  stdin?: string;
}

export interface DocxToolResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const DEFAULT_TIMEOUT_MS = 5 * 60_000; // 5 minutes — helper ops can be slow.

export async function runDocxTool(
  workspace: Workspace,
  { subcommand, args = [], stdin }: DocxToolArgs,
): Promise<DocxToolResult> {
  if (!subcommand || typeof subcommand !== "string") {
    throw new Error("subcommand is required");
  }

  const helperPath = path.join(workspace.dir, "docx-tool");
  const spawnArgs = [subcommand, ...args];

  return await new Promise<DocxToolResult>((resolve) => {
    const child = spawn(helperPath, spawnArgs, {
      cwd: workspace.dir,
      env: {
        ...process.env,
        PI_DOCX_WORKSPACE_DIR: workspace.dir,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let finished = false;

    child.stdout.on("data", (c: Buffer) => {
      stdout += c.toString("utf-8");
    });
    child.stderr.on("data", (c: Buffer) => {
      stderr += c.toString("utf-8");
    });

    const timer = setTimeout(() => {
      if (finished) return;
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
    }, DEFAULT_TIMEOUT_MS);
    timer.unref?.();

    const onDone = (code: number) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      const exitCode = typeof code === "number" ? code : 1;
      // Schedule a checkpoint iff the helper ran a mutating subcommand and
      // exited cleanly. Non-zero exits are treated as failed mutations and
      // skipped so we don't churn checkpoints for error paths.
      if (exitCode === 0 && isMutatingDocxSubcommand(subcommand)) {
        try {
          scheduleCheckpoint(workspace.id, `docx-tool ${subcommand}`);
        } catch (err) {
          console.warn(
            `[docx-tool] scheduleCheckpoint failed for workspace=${workspace.id}:`,
            (err as Error).message,
          );
        }
      }
      resolve({ stdout, stderr, exitCode });
    };

    child.on("error", (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({
        stdout,
        stderr: stderr + `\ndocx-tool spawn error: ${err.message}`,
        exitCode: -1,
      });
    });
    child.on("close", (code) => onDone(code ?? 1));

    if (stdin !== undefined && stdin.length > 0) {
      child.stdin.write(stdin);
    }
    child.stdin.end();
  });
}
