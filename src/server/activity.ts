import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { resolveWithinWorkspace, WORKSPACES_ROOT } from "./workspace";
import type { ActivityEvent } from "../lib/types";

function datestamp(date = new Date()): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export async function appendActivity(
  workspaceId: string,
  event: { type: string; ts?: string } & Record<string, unknown>,
): Promise<void> {
  // Route through the workspace path resolver so we get the same traversal
  // protection the HTTP routes get.
  const fileRel = path.join("activity", `${datestamp()}.jsonl`);
  let targetPath: string;
  try {
    targetPath = resolveWithinWorkspace(workspaceId, fileRel);
  } catch (err) {
    // Unknown workspace id shape — skip silently so we don't blow up callers.
    console.warn(
      `[activity] refusing to write for invalid workspaceId=${workspaceId}:`,
      (err as Error).message,
    );
    return;
  }

  const activityDir = path.dirname(targetPath);
  await mkdir(activityDir, { recursive: true });
  const record: ActivityEvent = {
    ts: event.ts ?? new Date().toISOString(),
    ...event,
  };
  await appendFile(targetPath, `${JSON.stringify(record)}\n`, "utf-8");
}

export function getActivityRoot(): string {
  return WORKSPACES_ROOT;
}
