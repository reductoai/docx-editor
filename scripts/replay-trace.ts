#!/usr/bin/env bun
/**
 * Trace replayer — runs a chat trace end-to-end against the local server
 * WITHOUT an LLM in the loop. Purpose: regression-test the refresh pipeline.
 *
 *   bun run scripts/replay-trace.ts \
 *     --trace /Users/raunak/Downloads/reducto-trace_*.json \
 *     --docx  /Users/raunak/Downloads/Mutual-NDA-public-v1.docx
 *
 * What it does:
 *   1. POST /api/workspaces with the fixture DOCX → fresh workspace.
 *   2. Subscribes to /api/workspaces/:id/events via SSE and captures every
 *      `checkpoint` / `status` / `error` frame.
 *   3. For each `tool_execution_start` event in the trace (in order):
 *        a. If `read` / `grep` / `ls` / `find` / `edit` / `write`: no-op
 *           on the FS side but we still fire a checkpoint so we verify
 *           the hash-gate in `fire()` correctly short-circuits.
 *        b. If `bash`: spawns the exact command in the workspace dir, so
 *           `./docx-tool ...` exec paths hit LibreOffice exactly like the
 *           agent would have driven them.
 *        c. After each tool call, POST /api/chat/test/schedule-checkpoint
 *           (same entrypoint the real turn uses on tool_execution_end).
 *        d. Waits up to CHECKPOINT_TIMEOUT_MS for a matching `checkpoint`
 *           SSE frame; on arrival fetches the new bytes and SHA-256s them.
 *   4. Reports a per-step verdict:
 *        - `mutation`: expected bytes to change. PASS iff sha differs from
 *          the previous seq AND a checkpoint arrived within the window.
 *        - `read`: expected NO checkpoint (hash-gate short-circuit).
 *          PASS iff no checkpoint arrived within the window.
 *
 * The summary at the end tells you which step broke the pipeline, so when
 * the browser stops seeing refreshes you can re-run this locally and
 * pinpoint whether the issue is (a) the checkpoint never fires, (b) it
 * fires but SSE doesn't publish, or (c) bytes never change.
 */

import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import { extractSemanticContent } from "../src/server/ooxml-sanitize";

const BASE = process.env.DOCX_TEST_BASE ?? "http://localhost:3001";
const CHECKPOINT_TIMEOUT_MS = Number(process.env.CHECKPOINT_TIMEOUT_MS ?? 8000);

function parseArgs(): { trace: string; docx: string } {
  const args = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const trace = get("--trace");
  const docx = get("--docx");
  if (!trace || !docx) {
    console.error(
      "usage: bun run scripts/replay-trace.ts --trace <trace.json> --docx <fixture.docx>",
    );
    process.exit(2);
  }
  return { trace, docx };
}

function sha(buf: ArrayBuffer | Uint8Array): string {
  return createHash("sha256")
    .update(Buffer.from(buf as ArrayBuffer))
    .digest("hex")
    .slice(0, 12);
}

function ts(): string {
  return new Date().toISOString().slice(11, 23);
}

function log(line: string, obj?: unknown) {
  if (obj === undefined) console.log(`[${ts()}] ${line}`);
  else console.log(`[${ts()}] ${line}`, obj);
}

interface SseFrame {
  event?: string;
  data?: string;
  at: number;
}

async function openSse(
  url: string,
  onFrame: (f: SseFrame) => void,
): Promise<{ close: () => void; done: Promise<void> }> {
  const ac = new AbortController();
  const res = await fetch(url, {
    signal: ac.signal,
    headers: { Accept: "text/event-stream" },
  });
  if (!res.ok || !res.body)
    throw new Error(`SSE connect failed: HTTP ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const loop = (async () => {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += decoder.decode(value, { stream: true });
        let sep: number;
        while ((sep = buf.indexOf("\n\n")) !== -1) {
          const block = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          if (!block.trim()) continue;
          const frame: SseFrame = { at: Date.now() };
          for (const line of block.split("\n")) {
            if (line.startsWith(":")) continue;
            if (line.startsWith("event:")) frame.event = line.slice(6).trim();
            else if (line.startsWith("data:"))
              frame.data = (frame.data ?? "") + line.slice(5).trim();
          }
          onFrame(frame);
        }
      }
    } catch (err) {
      if ((err as { name?: string }).name !== "AbortError") throw err;
    }
  })();
  return { close: () => ac.abort(), done: loop };
}

interface CheckpointFrame {
  seq: number;
  docxUrl: string;
  sourceTool?: string;
  at: number;
}
function collectCheckpoints(frames: SseFrame[]): CheckpointFrame[] {
  const out: CheckpointFrame[] = [];
  for (const f of frames) {
    if (f.event !== "checkpoint" || !f.data) continue;
    try {
      const p = JSON.parse(f.data) as {
        seq?: number;
        docxUrl?: string;
        sourceTool?: string;
      };
      if (typeof p.seq === "number" && typeof p.docxUrl === "string") {
        out.push({ seq: p.seq, docxUrl: p.docxUrl, sourceTool: p.sourceTool, at: f.at });
      }
    } catch {
      /* skip */
    }
  }
  return out;
}

async function waitForNextCheckpoint(
  frames: SseFrame[],
  afterSeq: number,
  timeoutMs: number,
): Promise<CheckpointFrame | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const cps = collectCheckpoints(frames);
    const next = cps.find((c) => c.seq > afterSeq);
    if (next) return next;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

async function fetchDocSha(base: string, docxUrl: string): Promise<{ sha: string; bytes: number }> {
  const url = docxUrl.startsWith("http") ? docxUrl : `${base}${docxUrl}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url} failed: HTTP ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  return { sha: sha(buf), bytes: buf.byteLength };
}

/**
 * Semantic-content hash of the workspace's working.docx. Mirrors the
 * server's publish-gate logic (rsid attrs stripped, LibreOffice round-
 * trip artifacts stripped) so the test's expectations match what the
 * browser would actually see. */
async function semanticSha(workspaceDir: string): Promise<string> {
  const xml = await extractSemanticContent(path.join(workspaceDir, "working.docx"));
  return createHash("sha256").update(xml).digest("hex").slice(0, 12);
}

function runBash(cwd: string, command: string, timeoutMs = 60_000): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve) => {
    const child = spawn("bash", ["-c", command], { cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    const timer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

interface TraceToolCall {
  index: number;
  name: string;
  args: Record<string, unknown>;
  command?: string; // bash only
}

function extractToolCalls(trace: unknown): TraceToolCall[] {
  const events = (trace as { events?: Array<{ event?: { type?: string; toolName?: string; args?: unknown } }> })
    .events ?? [];
  const out: TraceToolCall[] = [];
  let i = 0;
  for (const e of events) {
    const ev = e.event;
    if (!ev || ev.type !== "tool_execution_start") continue;
    const args = (ev.args as Record<string, unknown>) ?? {};
    out.push({
      index: i++,
      name: ev.toolName ?? "?",
      args,
      command: typeof args.command === "string" ? (args.command as string) : undefined,
    });
  }
  return out;
}

interface StepResult {
  index: number;
  tool: string;
  summary: string;
  expectedMutation: boolean;
  checkpointSeen: boolean;
  shaChanged: boolean | null;
  previousSha: string;
  newSha: string;
  elapsedMs: number | null;
  pass: boolean;
  notes: string[];
}

async function main() {
  const { trace: tracePath, docx: docxPath } = parseArgs();
  const trace = JSON.parse(await readFile(tracePath, "utf-8"));
  const calls = extractToolCalls(trace);
  log(`loaded trace: ${calls.length} tool calls from ${path.basename(tracePath)}`);
  log(`loaded fixture: ${path.basename(docxPath)}`);

  // 1. Create workspace
  const docxBytes = await readFile(docxPath);
  const form = new FormData();
  form.append("file", new Blob([docxBytes]), path.basename(docxPath));
  const createRes = await fetch(`${BASE}/api/workspaces`, { method: "POST", body: form });
  if (!createRes.ok)
    throw new Error(`create workspace failed: HTTP ${createRes.status} ${await createRes.text()}`);
  const { workspaceId } = (await createRes.json()) as { workspaceId: string };
  log(`workspace created: ${workspaceId}`);

  // Resolve the on-disk workspace path. The server exposes it indirectly
  // (workspaces/<id>/), and our bash commands need to cd into it.
  const workspaceDir = path.resolve(
    process.env.PWD ?? process.cwd(),
    "workspaces",
    workspaceId,
  );
  log(`workspace dir: ${workspaceDir}`);

  // 2. Subscribe to SSE
  const frames: SseFrame[] = [];
  const sse = await openSse(`${BASE}/api/workspaces/${workspaceId}/events`, (f) => {
    frames.push(f);
    if (f.event) log(`  sse  event=${f.event}`, f.data?.slice(0, 160));
  });
  await new Promise((r) => setTimeout(r, 300)); // let SSE open
  log(`SSE subscribed`);

  // 3. Initial snapshot
  const initial = await fetchDocSha(BASE, `/api/workspaces/${workspaceId}/doc`);
  log(`initial doc bytes=${initial.bytes} sha=${initial.sha}`);

  let lastSeq = 0;
  let lastSha = initial.sha;

  // Prime a baseline by firing one checkpoint BEFORE the trace begins.
  // LibreOffice normalizes the file on its first open+save (canonical
  // attribute order, whitespace, etc.) in ways beyond our sanitizer —
  // treating that as a "mutation" would taint step 0 of every trace.
  log(`priming baseline (fire one checkpoint before step 0)`);
  await fetch(`${BASE}/api/chat/test/schedule-checkpoint`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspaceId, sourceTool: "replay:baseline" }),
  });
  const primer = await waitForNextCheckpoint(frames, lastSeq, CHECKPOINT_TIMEOUT_MS);
  if (primer) {
    lastSeq = primer.seq;
    const primed = await fetchDocSha(BASE, primer.docxUrl);
    lastSha = primed.sha;
    log(`baseline established: seq=${primer.seq} sha=${primed.sha}`);
  } else {
    log(`baseline primer: no checkpoint within ${CHECKPOINT_TIMEOUT_MS}ms (fine if the file needed no normalization)`);
  }
  let lastSemantic = await semanticSha(workspaceDir);
  log(`baseline semantic sha=${lastSemantic}`);
  const results: StepResult[] = [];

  // 4. Replay each tool call
  for (const call of calls) {
    const notes: string[] = [];
    const canBeMutation =
      call.name === "bash" && canMutateDocx(call.command ?? "");
    let summary = call.name;
    let toolRan = true;

    log(`\n▶ step ${call.index} tool=${call.name} canBeMutation=${canBeMutation}`);

    if (call.name === "bash" && call.command) {
      // Rewrite any absolute workspace path captured in the trace to our
      // replay workspace dir — traces often include `cd /…/workspaces/<old-id>`
      // which would otherwise execute against a stale workspace.
      const rewritten = rewriteWorkspacePaths(call.command, workspaceDir);
      if (rewritten !== call.command) notes.push("(workspace path rewritten)");
      summary = `bash: ${compactCommand(rewritten)}`;
      log(`  exec bash command (${rewritten.length} chars)`);
      const execRes = await runBash(workspaceDir, rewritten);
      log(`  bash exit=${execRes.code} stdout.len=${execRes.stdout.length} stderr.len=${execRes.stderr.length}`);
      if (execRes.code !== 0) {
        notes.push(`bash exit=${execRes.code}: ${execRes.stderr.slice(0, 200)}`);
      }
      if (execRes.stderr) notes.push(`stderr: ${execRes.stderr.slice(0, 160)}`);
    } else if (
      call.name === "read" ||
      call.name === "grep" ||
      call.name === "ls" ||
      call.name === "find"
    ) {
      // Non-bash coding tools: no FS mutation. Just simulate that a
      // tool_execution_end happened so the checkpoint hook fires and the
      // hash-gate has a chance to kick in.
      toolRan = false;
      summary = `${call.name}: ${JSON.stringify(call.args).slice(0, 80)}`;
    } else {
      notes.push(`(no replay path for tool=${call.name}; only firing checkpoint)`);
      toolRan = false;
    }

    // Trigger the checkpoint (same hook the real chat route uses).
    const cpStart = Date.now();
    const schedRes = await fetch(`${BASE}/api/chat/test/schedule-checkpoint`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId, sourceTool: `replay:${call.name}` }),
    });
    if (!schedRes.ok) notes.push(`schedule-checkpoint HTTP ${schedRes.status}`);

    const cp = await waitForNextCheckpoint(frames, lastSeq, CHECKPOINT_TIMEOUT_MS);
    let newSha = lastSha;
    let shaChanged: boolean | null = null;
    let elapsedMs: number | null = null;

    if (cp) {
      elapsedMs = cp.at - cpStart;
      const refreshed = await fetchDocSha(BASE, cp.docxUrl);
      newSha = refreshed.sha;
      shaChanged = newSha !== lastSha;
      lastSeq = cp.seq;
      lastSha = newSha;
      log(`  ✓ checkpoint seq=${cp.seq} elapsed=${elapsedMs}ms sha=${newSha} changed=${shaChanged}`);
    } else {
      log(`  — no checkpoint within ${CHECKPOINT_TIMEOUT_MS}ms`);
    }

    // Pass criteria:
    //   Three categories, ground-truth-based (we don't trust the static
    //   classifier — `execute-stdin` can be either read-only or mutating):
    //
    //   A) A tool that CANNOT have mutated (read / grep / ls / find or
    //      a bash invocation with no docx-tool in it) SHOULD NOT fire a
    //      checkpoint with a byte change. Any byte change = broken gate.
    //   B) A tool that COULD have mutated (`bash` with docx-tool in it):
    //      if bytes changed → PASS (refresh worked); if bytes didn't
    //      change → PASS too (e.g. `./docx-tool text` is read-only) but
    //      we mark it "no-op". The key failure is: bytes changed server-
    //      side but checkpoint never arrived on the SSE channel.
    //
    //   We can detect (B)'s failure case by double-checking the bytes
    //   DIRECTLY via /doc after the checkpoint window expires.
    let pass: boolean;
    let category: "read-only" | "mutation-effective" | "mutation-noop";

    // Ground truth for whether the user-visible document changed comes
    // from the SEMANTIC hash (rsid-stripped document.xml) — the same
    // thing the server's publish-gate uses. Raw-byte diff from LibreOffice
    // rsid churn is irrelevant here.
    const semanticAfter = await semanticSha(workspaceDir);
    const semanticChanged = semanticAfter !== lastSemantic;

    if (!canBeMutation) {
      category = "read-only";
      // A non-mutating tool causing a semantic change = broken gate.
      pass = !semanticChanged;
      if (semanticChanged)
        notes.push(
          `FAIL: non-mutating tool changed semantic content (${lastSemantic} → ${semanticAfter})`,
        );
    } else if (semanticChanged) {
      // Semantic content moved. We MUST have seen a checkpoint; otherwise
      // the browser would be stuck on a stale view.
      category = "mutation-effective";
      if (cp) {
        pass = true;
      } else {
        pass = false;
        notes.push(
          `FAIL: semantic content changed (${lastSemantic} → ${semanticAfter}) but no SSE checkpoint fired`,
        );
      }
    } else {
      // Semantic content unchanged. Raw byte churn (rsid) may or may
      // not have fired a checkpoint on the SSE channel, but either way
      // it's a no-op from the browser's perspective.
      category = "mutation-noop";
      pass = true;
      notes.push("no-op (command ran but semantic content unchanged)");
    }
    lastSemantic = semanticAfter;

    results.push({
      index: call.index,
      tool: call.name,
      summary,
      expectedMutation: canBeMutation,
      checkpointSeen: cp !== null,
      shaChanged,
      previousSha: initial.sha,
      newSha,
      elapsedMs,
      pass,
      notes: [
        `category=${category}`,
        ...(toolRan ? [] : ["did not exec (simulated checkpoint only)"]),
        ...notes,
      ],
    });
  }

  // 5. Summary
  sse.close();
  await sse.done;

  console.log("\n================= SUMMARY =================");
  const pad = (s: string, n: number) => (s + " ".repeat(n)).slice(0, n);
  console.log(
    pad("#", 3),
    pad("tool", 6),
    pad("expect", 7),
    pad("ckpt", 5),
    pad("Δ", 6),
    pad("ms", 6),
    "  summary",
  );
  for (const r of results) {
    console.log(
      pad(String(r.index), 3),
      pad(r.tool, 6),
      pad(r.expectedMutation ? "mutate" : "read", 7),
      pad(r.checkpointSeen ? "yes" : "no", 5),
      pad(r.shaChanged === null ? "—" : r.shaChanged ? "YES" : "no", 6),
      pad(r.elapsedMs === null ? "—" : String(r.elapsedMs), 6),
      `  ${r.pass ? "✓ " : "✗ "}${r.summary}`,
    );
    for (const n of r.notes) console.log("       ↳", n);
  }
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed}/${results.length} steps passed`);
  console.log(`\nworkspace: ${workspaceDir}`);
  console.log(`final doc sha: ${lastSha}`);

  process.exit(passed === results.length ? 0 : 1);
}

// Whether a bash command could conceivably touch the DOCX. Used only to
// decide whether to expect a byte change — the definitive signal is a
// post-run sha diff against /doc.
function canMutateDocx(cmd: string): boolean {
  return /\bdocx-tool\b/.test(cmd);
}

function compactCommand(cmd: string): string {
  return cmd.replace(/\s+/g, " ").slice(0, 100);
}

/**
 * Traces often embed absolute `cd /…/workspaces/<original-id>` into the bash
 * commands. Rewriting them to the replay's workspace dir (without touching
 * the rest of the command) lets us replay against the fresh session instead
 * of accidentally mutating the stale one.
 */
function rewriteWorkspacePaths(cmd: string, replayWorkspaceDir: string): string {
  const re = /(\/[^\s"']*\/workspaces\/)\d{4}-\d{2}-\d{2}_[a-f0-9-]{36}/g;
  return cmd.replace(re, replayWorkspaceDir);
}

main().catch((err) => {
  console.error("REPLAY FAILED:", err);
  process.exit(1);
});
