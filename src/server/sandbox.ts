import { realpath } from "node:fs/promises";
import path from "node:path";

/**
 * Thrown when a caller tries to escape the workspace sandbox via an absolute
 * path, `..` traversal, or a symlink that resolves outside the workspace dir.
 */
export class SandboxEscapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxEscapeError";
  }
}

/**
 * Resolves a workspace-relative path against `workspaceDir`, throwing
 * `SandboxEscapeError` on any attempt to escape. Follows symlinks via
 * `realpath` where possible; for paths that don't exist yet we fall back to
 * the resolved (non-realpath) string.
 *
 * Unit 4's `src/server/workspace.ts` exports a sibling helper that takes a
 * workspace *id* and does the same job. Prefer that helper when you already
 * have the workspace id in hand; use this one when you have the directory.
 */
export function resolveWithinWorkspace(
  workspaceDir: string,
  relPath: string,
): string {
  if (typeof workspaceDir !== "string" || workspaceDir.length === 0) {
    throw new SandboxEscapeError("workspaceDir is required");
  }
  if (typeof relPath !== "string" || relPath.length === 0) {
    throw new SandboxEscapeError("relative path is required");
  }
  if (path.isAbsolute(relPath)) {
    throw new SandboxEscapeError(`refusing absolute path: ${relPath}`);
  }
  // Platform root check: on win32 `path.isAbsolute` already catches `C:\...`
  // and leading `/`. On posix anything starting with `/` is absolute too.
  if (relPath.startsWith("/") || relPath.startsWith("\\")) {
    throw new SandboxEscapeError(`refusing absolute path: ${relPath}`);
  }

  const root = path.resolve(workspaceDir);
  const resolved = path.resolve(root, relPath);
  const prefix = root + path.sep;
  if (resolved !== root && !resolved.startsWith(prefix)) {
    throw new SandboxEscapeError(
      `path escapes workspace: ${relPath} -> ${resolved}`,
    );
  }
  return resolved;
}

/**
 * Async variant that additionally resolves symlinks via `realpath` when the
 * target exists. Falls back to the synchronous resolution for not-yet-created
 * paths (e.g. before a write). Both the resolved path and its realpath must
 * live inside the workspace dir.
 */
export async function resolveWithinWorkspaceReal(
  workspaceDir: string,
  relPath: string,
): Promise<string> {
  const resolved = resolveWithinWorkspace(workspaceDir, relPath);
  const root = path.resolve(workspaceDir);
  const prefix = root + path.sep;

  // The resolved path may not exist yet (e.g. for a write). In that case we
  // walk up until we find an existing ancestor and realpath that, then append
  // the remainder. This catches symlink-to-outside ancestors without failing
  // on the leaf not existing.
  let existing = resolved;
  let tail = "";
  // Bound the climb by the workspace root so we never realpath past it.
  while (existing !== root) {
    try {
      const real = await realpath(existing);
      const rootReal = await realpath(root).catch(() => root);
      const realPrefix = rootReal + path.sep;
      if (real !== rootReal && !real.startsWith(realPrefix)) {
        throw new SandboxEscapeError(
          `symlink escapes workspace: ${relPath} -> ${real}`,
        );
      }
      return tail ? path.join(real, tail) : real;
    } catch (err) {
      if (err instanceof SandboxEscapeError) throw err;
      // ENOENT (or other): climb one level and try again.
      const parent = path.dirname(existing);
      if (parent === existing) break;
      tail = tail ? path.join(path.basename(existing), tail) : path.basename(existing);
      existing = parent;
    }
  }
  // Fallback to the lexically-resolved path if nothing existed.
  if (resolved !== root && !resolved.startsWith(prefix)) {
    throw new SandboxEscapeError(
      `path escapes workspace: ${relPath} -> ${resolved}`,
    );
  }
  return resolved;
}
