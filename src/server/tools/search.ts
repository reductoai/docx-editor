import { spawn } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { resolveWithinWorkspaceReal } from "../sandbox";
import type { Workspace } from "../workspace";

const MAX_RESULTS = 500;

export interface GrepArgs {
  pattern: string;
  path?: string;
  glob?: string;
  ignoreCase?: boolean;
  literal?: boolean;
}

export interface GrepMatch {
  file: string;
  line: number;
  text: string;
}

export interface GrepResult {
  matches: GrepMatch[];
  truncated: boolean;
  backend: "rg" | "fallback";
}

export interface FindArgs {
  pattern: string;
  path?: string;
}

export interface FindResult {
  files: string[];
  truncated: boolean;
  backend: "fd" | "fallback";
}

let rgAvailable: boolean | null = null;
let fdAvailable: boolean | null = null;

async function checkBinary(name: string): Promise<boolean> {
  return await new Promise((resolve) => {
    try {
      const child = spawn(name, ["--version"], { stdio: "ignore" });
      child.on("error", () => resolve(false));
      child.on("close", (code) => resolve(code === 0));
    } catch {
      resolve(false);
    }
  });
}

async function hasRg(): Promise<boolean> {
  if (rgAvailable !== null) return rgAvailable;
  rgAvailable = await checkBinary("rg");
  return rgAvailable;
}

async function hasFd(): Promise<boolean> {
  if (fdAvailable !== null) return fdAvailable;
  fdAvailable = await checkBinary("fd");
  return fdAvailable;
}

// Skip recursing into these directories during fallback walks.
const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  ".next",
  "dist",
  "build",
  ".turbo",
  ".cache",
  ".venv",
  "__pycache__",
]);

async function* walk(
  rootAbs: string,
  currentAbs: string,
  relPrefix: string,
): AsyncGenerator<{ absPath: string; relPath: string; isFile: boolean }> {
  let entries: string[] = [];
  try {
    entries = await readdir(currentAbs);
  } catch {
    return;
  }
  entries.sort();
  for (const name of entries) {
    if (IGNORED_DIRS.has(name)) continue;
    const absPath = path.join(currentAbs, name);
    const relPath = relPrefix ? path.join(relPrefix, name) : name;
    let info;
    try {
      info = await stat(absPath);
    } catch {
      continue;
    }
    if (info.isDirectory()) {
      yield { absPath, relPath, isFile: false };
      yield* walk(rootAbs, absPath, relPath);
    } else if (info.isFile()) {
      yield { absPath, relPath, isFile: true };
    }
  }
}

function matchesGlob(relPath: string, glob: string): boolean {
  // Minimal glob: translate * -> [^/]*, ** -> .*, ? -> single char.
  // Good enough for the tool's usage from the agent; server-side fallback
  // only.
  const special = /[.+^${}()|[\]\\]/g;
  const regexStr = glob
    .replace(special, "\\$&")
    .replace(/\\\*\\\*/g, "::DOUBLESTAR::")
    .replace(/\\\*/g, "[^/]*")
    .replace(/::DOUBLESTAR::/g, ".*")
    .replace(/\\\?/g, ".");
  const re = new RegExp(`^${regexStr}$`);
  return re.test(relPath) || re.test(path.basename(relPath));
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function runSubprocess(
  command: string,
  args: string[],
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return await new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => {
      stdout += c.toString("utf-8");
    });
    child.stderr.on("data", (c: Buffer) => {
      stderr += c.toString("utf-8");
    });
    child.on("error", () => resolve({ code: -1, stdout, stderr }));
    child.on("close", (code) =>
      resolve({ code: typeof code === "number" ? code : -1, stdout, stderr }),
    );
  });
}

export async function grep(
  workspace: Workspace,
  args: GrepArgs,
): Promise<GrepResult> {
  const relRoot = args.path && args.path.length > 0 ? args.path : ".";
  const searchAbs = await resolveWithinWorkspaceReal(workspace.dir, relRoot);

  if (await hasRg()) {
    const cliArgs: string[] = [
      "--no-heading",
      "--line-number",
      "--color",
      "never",
      `--max-count=${MAX_RESULTS}`,
    ];
    if (args.ignoreCase) cliArgs.push("-i");
    if (args.literal) cliArgs.push("-F");
    if (args.glob) cliArgs.push("--glob", args.glob);
    cliArgs.push("--", args.pattern, searchAbs);
    const { stdout, code } = await runSubprocess("rg", cliArgs, workspace.dir);
    // rg exit code 1 just means no matches; anything >1 is a real error.
    if (code !== 0 && code !== 1) {
      return { matches: [], truncated: false, backend: "rg" };
    }
    const matches: GrepMatch[] = [];
    const lines = stdout.split(/\r?\n/);
    for (const line of lines) {
      if (!line) continue;
      // Format: <path>:<line>:<text>
      const first = line.indexOf(":");
      if (first < 0) continue;
      const second = line.indexOf(":", first + 1);
      if (second < 0) continue;
      const file = line.slice(0, first);
      const lineNumStr = line.slice(first + 1, second);
      const text = line.slice(second + 1);
      const lineNum = Number(lineNumStr);
      if (!Number.isFinite(lineNum)) continue;
      matches.push({
        file: path.relative(workspace.dir, file) || file,
        line: lineNum,
        text,
      });
      if (matches.length >= MAX_RESULTS) break;
    }
    return {
      matches,
      truncated: matches.length >= MAX_RESULTS,
      backend: "rg",
    };
  }

  // Fallback: in-process regex over the tree.
  const flags = args.ignoreCase ? "i" : "";
  const patternStr = args.literal ? escapeRegex(args.pattern) : args.pattern;
  let re: RegExp;
  try {
    re = new RegExp(patternStr, flags);
  } catch (err) {
    throw new Error(
      `invalid regex: ${(err as Error).message}`,
    );
  }

  const matches: GrepMatch[] = [];
  let truncated = false;
  const rootAbs = path.resolve(workspace.dir);
  const startInfo = await stat(searchAbs);

  const filesToScan: Array<{ absPath: string; relPath: string }> = [];
  if (startInfo.isFile()) {
    filesToScan.push({
      absPath: searchAbs,
      relPath: path.relative(rootAbs, searchAbs),
    });
  } else {
    const startRel = path.relative(rootAbs, searchAbs);
    for await (const entry of walk(rootAbs, searchAbs, startRel)) {
      if (!entry.isFile) continue;
      if (args.glob && !matchesGlob(entry.relPath, args.glob)) continue;
      filesToScan.push({ absPath: entry.absPath, relPath: entry.relPath });
    }
  }

  outer: for (const { absPath, relPath } of filesToScan) {
    let content: string;
    try {
      const buf = await readFile(absPath);
      // Skip files that look binary: very rough heuristic.
      if (buf.includes(0)) continue;
      content = buf.toString("utf-8");
    } catch {
      continue;
    }
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i]!)) {
        matches.push({ file: relPath, line: i + 1, text: lines[i]! });
        if (matches.length >= MAX_RESULTS) {
          truncated = true;
          break outer;
        }
      }
      // Reset global flags between lines (defensive — our re has no /g).
      re.lastIndex = 0;
    }
  }

  return { matches, truncated, backend: "fallback" };
}

export async function find(
  workspace: Workspace,
  args: FindArgs,
): Promise<FindResult> {
  const relRoot = args.path && args.path.length > 0 ? args.path : ".";
  const searchAbs = await resolveWithinWorkspaceReal(workspace.dir, relRoot);

  if (await hasFd()) {
    const { stdout, code } = await runSubprocess(
      "fd",
      ["--type", "f", "--max-results", String(MAX_RESULTS), args.pattern, searchAbs],
      workspace.dir,
    );
    if (code !== 0) {
      return { files: [], truncated: false, backend: "fd" };
    }
    const files = stdout
      .split(/\r?\n/)
      .filter((l) => l.length > 0)
      .map((abs) => path.relative(workspace.dir, abs) || abs)
      .slice(0, MAX_RESULTS);
    return {
      files,
      truncated: files.length >= MAX_RESULTS,
      backend: "fd",
    };
  }

  // Fallback: in-process walk with regex match against basename and rel path.
  let re: RegExp;
  try {
    re = new RegExp(args.pattern);
  } catch (err) {
    throw new Error(`invalid regex: ${(err as Error).message}`);
  }
  const files: string[] = [];
  let truncated = false;
  const rootAbs = path.resolve(workspace.dir);
  const startInfo = await stat(searchAbs);
  if (startInfo.isFile()) {
    const rel = path.relative(rootAbs, searchAbs);
    if (re.test(path.basename(rel)) || re.test(rel)) files.push(rel);
  } else {
    const startRel = path.relative(rootAbs, searchAbs);
    for await (const entry of walk(rootAbs, searchAbs, startRel)) {
      if (!entry.isFile) continue;
      if (re.test(path.basename(entry.relPath)) || re.test(entry.relPath)) {
        files.push(entry.relPath);
        if (files.length >= MAX_RESULTS) {
          truncated = true;
          break;
        }
      }
    }
  }

  return { files, truncated, backend: "fallback" };
}
