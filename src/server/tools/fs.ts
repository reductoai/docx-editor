import {
  mkdir,
  readFile as nodeReadFile,
  readdir,
  stat,
  writeFile as nodeWriteFile,
  lstat,
} from "node:fs/promises";
import path from "node:path";
import { resolveWithinWorkspaceReal } from "../sandbox";
import type { Workspace } from "../workspace";

const DEFAULT_READ_BYTE_CAP = 2 * 1024 * 1024; // 2 MB

export interface ReadFileArgs {
  path: string;
  offset?: number;
  limit?: number;
}

export interface ReadFileResult {
  content: string;
  byteSize: number;
  truncated: boolean;
}

export async function readFile(
  workspace: Workspace,
  { path: relPath, offset, limit }: ReadFileArgs,
): Promise<ReadFileResult> {
  const absolute = await resolveWithinWorkspaceReal(workspace.dir, relPath);
  const info = await stat(absolute);
  if (info.isDirectory()) {
    throw new Error(`path is a directory: ${relPath}`);
  }
  const byteSize = info.size;
  const tooLarge = byteSize > DEFAULT_READ_BYTE_CAP;

  // If the file is too big, only read the cap. We still flag `truncated`.
  const raw = await nodeReadFile(absolute);
  const bytesToDecode = tooLarge ? raw.subarray(0, DEFAULT_READ_BYTE_CAP) : raw;
  let content = bytesToDecode.toString("utf-8");
  let truncated = tooLarge;

  if (typeof offset === "number" || typeof limit === "number") {
    const lines = content.split(/\r?\n/);
    const start = typeof offset === "number" && offset > 0 ? offset : 0;
    const end =
      typeof limit === "number" && limit > 0
        ? Math.min(lines.length, start + limit)
        : lines.length;
    if (start > 0 || end < lines.length) {
      truncated = truncated || end < lines.length || start > 0;
      content = lines.slice(start, end).join("\n");
    }
  }

  return { content, byteSize, truncated };
}

export interface WriteFileArgs {
  path: string;
  content: string;
}

export interface WriteFileResult {
  bytesWritten: number;
}

export async function writeFile(
  workspace: Workspace,
  { path: relPath, content }: WriteFileArgs,
): Promise<WriteFileResult> {
  const absolute = await resolveWithinWorkspaceReal(workspace.dir, relPath);
  await mkdir(path.dirname(absolute), { recursive: true });
  const buf = Buffer.from(content, "utf-8");
  await nodeWriteFile(absolute, buf);
  return { bytesWritten: buf.byteLength };
}

export interface EditEntry {
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

export interface EditFileArgs {
  path: string;
  edits: EditEntry[];
}

export interface EditFileResult {
  replacements: number;
}

export async function editFile(
  workspace: Workspace,
  { path: relPath, edits }: EditFileArgs,
): Promise<EditFileResult> {
  if (!Array.isArray(edits) || edits.length === 0) {
    throw new Error("edits must be a non-empty array");
  }
  const absolute = await resolveWithinWorkspaceReal(workspace.dir, relPath);
  const original = await nodeReadFile(absolute, "utf-8");
  let current = original;
  let totalReplacements = 0;

  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i]!;
    const { old_string, new_string, replace_all } = edit;
    if (typeof old_string !== "string" || old_string.length === 0) {
      throw new Error(`edits[${i}].old_string must be a non-empty string`);
    }
    if (typeof new_string !== "string") {
      throw new Error(`edits[${i}].new_string must be a string`);
    }

    if (replace_all) {
      const parts = current.split(old_string);
      const count = parts.length - 1;
      if (count === 0) {
        throw new Error(
          `edits[${i}]: old_string not found in ${relPath}`,
        );
      }
      current = parts.join(new_string);
      totalReplacements += count;
    } else {
      const firstIdx = current.indexOf(old_string);
      if (firstIdx < 0) {
        throw new Error(
          `edits[${i}]: old_string not found in ${relPath}`,
        );
      }
      const secondIdx = current.indexOf(
        old_string,
        firstIdx + old_string.length,
      );
      if (secondIdx >= 0) {
        throw new Error(
          `edits[${i}]: old_string matches ${countOccurrences(
            current,
            old_string,
          )} places in ${relPath}; require a unique match or set replace_all: true`,
        );
      }
      current =
        current.slice(0, firstIdx) +
        new_string +
        current.slice(firstIdx + old_string.length);
      totalReplacements += 1;
    }
  }

  await nodeWriteFile(absolute, current, "utf-8");
  return { replacements: totalReplacements };
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let idx = 0;
  while (true) {
    const next = haystack.indexOf(needle, idx);
    if (next < 0) break;
    count += 1;
    idx = next + needle.length;
  }
  return count;
}

export interface ListDirArgs {
  path?: string;
}

export interface ListEntry {
  name: string;
  kind: "file" | "dir" | "symlink";
  size?: number;
}

export interface ListDirResult {
  entries: ListEntry[];
}

export async function listDir(
  workspace: Workspace,
  { path: relPath }: ListDirArgs = {},
): Promise<ListDirResult> {
  const effective = relPath && relPath.length > 0 ? relPath : ".";
  const absolute = await resolveWithinWorkspaceReal(workspace.dir, effective);
  const info = await stat(absolute);
  if (!info.isDirectory()) {
    throw new Error(`path is not a directory: ${effective}`);
  }
  const names = await readdir(absolute);
  names.sort((a, b) => a.localeCompare(b));
  const entries: ListEntry[] = [];
  for (const name of names) {
    const full = path.join(absolute, name);
    try {
      const entryInfo = await lstat(full);
      let kind: ListEntry["kind"];
      if (entryInfo.isSymbolicLink()) kind = "symlink";
      else if (entryInfo.isDirectory()) kind = "dir";
      else kind = "file";
      const entry: ListEntry = { name, kind };
      if (kind === "file") entry.size = entryInfo.size;
      entries.push(entry);
    } catch {
      // Skip entries we can't stat.
    }
  }
  return { entries };
}
