#!/usr/bin/env bun
/**
 * End-to-end smoke test for the live checkpoint / auto-refresh pipeline.
 *
 * Simulates what the browser does:
 *   1. POST /api/workspaces         — upload a test DOCX
 *   2. GET  /api/workspaces/:id/events   (SSE, captures every frame)
 *   3. GET  /api/workspaces/:id/doc      (initial buffer + SHA)
 *   4. POST /api/tools/docx-tool    — append a unique paragraph
 *   5. Wait up to 10s for a `checkpoint` SSE event
 *   6. Fetch the new bytes via `docxUrl`; compare SHA + byte length
 *   7. Confirm the new text is present via `docx-tool find-text`
 *
 * This bypasses the agent loop and SuperDoc entirely — if this test passes,
 * the server is firing checkpoints and serving fresh bytes. If the browser UI
 * still doesn't refresh, the bug is client-side (SSE connect, buffer swap, or
 * SuperDoc re-render).
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

const BASE = process.env.DOCX_TEST_BASE ?? "http://localhost:3000";

const FIXTURE =
  process.env.DOCX_TEST_FIXTURE ??
  path.resolve(
    import.meta.dir,
    "../reference/sbs-discovery-depositions-notice.docx",
  );

function sha(buf: ArrayBuffer | Uint8Array): string {
  const h = createHash("sha256");
  h.update(Buffer.from(buf as ArrayBuffer));
  return h.digest("hex").slice(0, 12);
}

function log(label: string, obj?: unknown) {
  const stamp = new Date().toISOString().slice(11, 23);
  if (obj === undefined) console.log(`[${stamp}] ${label}`);
  else console.log(`[${stamp}] ${label}`, obj);
}

interface SseFrame {
  event?: string;
  data?: string;
  at: number;
}

async function openSse(url: string, onFrame: (f: SseFrame) => void): Promise<{
  close: () => void;
  done: Promise<void>;
}> {
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
        let sepIdx: number;
        while ((sepIdx = buf.indexOf("\n\n")) !== -1) {
          const block = buf.slice(0, sepIdx);
          buf = buf.slice(sepIdx + 2);
          if (!block.trim()) continue;
          const frame: SseFrame = { at: Date.now() };
          for (const line of block.split("\n")) {
            if (line.startsWith(":")) continue; // heartbeat / comment
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

  return {
    close: () => ac.abort(),
    done: loop,
  };
}

async function waitForCheckpoint(
  frames: SseFrame[],
  afterTs: number,
  minSeq: number,
  timeoutMs: number,
): Promise<{ seq: number; docxUrl: string; sourceTool?: string }> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    for (const f of frames) {
      if (f.at < afterTs || f.event !== "checkpoint" || !f.data) continue;
      try {
        const parsed = JSON.parse(f.data) as {
          kind?: string;
          seq?: number;
          docxUrl?: string;
          sourceTool?: string;
        };
        if (parsed.kind === "checkpoint" && typeof parsed.seq === "number"
            && parsed.seq >= minSeq && typeof parsed.docxUrl === "string") {
          return { seq: parsed.seq, docxUrl: parsed.docxUrl, sourceTool: parsed.sourceTool };
        }
      } catch {
        // ignore parse
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timeout waiting for checkpoint seq>=${minSeq}`);
}

async function main() {
  log(`fixture=${FIXTURE}`);
  const fixtureBytes = await readFile(FIXTURE);
  log(`fixture bytes=${fixtureBytes.byteLength} sha=${sha(fixtureBytes)}`);

  // 1. Create workspace
  const form = new FormData();
  form.append("file", new Blob([fixtureBytes]), path.basename(FIXTURE));
  const createRes = await fetch(`${BASE}/api/workspaces`, { method: "POST", body: form });
  if (!createRes.ok) throw new Error(`create failed: HTTP ${createRes.status} ${await createRes.text()}`);
  const { workspaceId } = (await createRes.json()) as { workspaceId: string };
  log(`workspace=${workspaceId}`);

  // 2. Open SSE
  const frames: SseFrame[] = [];
  const sse = await openSse(`${BASE}/api/workspaces/${workspaceId}/events`, (f) => {
    frames.push(f);
    if (f.event) log(`sse event=${f.event}`, f.data);
  });
  // Give SSE a beat to open
  await new Promise((r) => setTimeout(r, 250));

  // 3. Initial doc fetch
  const initialRes = await fetch(`${BASE}/api/workspaces/${workspaceId}/doc`);
  const initialBuf = new Uint8Array(await initialRes.arrayBuffer());
  const initialSha = sha(initialBuf);
  log(`initial doc bytes=${initialBuf.byteLength} sha=${initialSha}`);

  // 4. Mutate — append a unique paragraph
  const marker = `REFRESH-TEST-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const mutateAt = Date.now();
  const mutateRes = await fetch(`${BASE}/api/tools/docx-tool`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      workspaceId,
      subcommand: "append-paragraph",
      args: ["--text", marker],
    }),
  });
  const mutateJson = await mutateRes.json();
  log(`append-paragraph ok=${mutateRes.ok}`, mutateJson);
  if (!mutateRes.ok) throw new Error("docx-tool append-paragraph failed");

  // 5. Wait for checkpoint
  const cp = await waitForCheckpoint(frames, mutateAt, 1, 10_000);
  log(`checkpoint received`, cp);
  const elapsed = Date.now() - mutateAt;
  log(`mutate -> checkpoint elapsed=${elapsed}ms`);

  // 6. Fetch the refreshed bytes — this is EXACTLY what the browser does
  const absolute = cp.docxUrl.startsWith("http") ? cp.docxUrl : `${BASE}${cp.docxUrl}`;
  const refreshedRes = await fetch(absolute);
  if (!refreshedRes.ok)
    throw new Error(`refreshed fetch failed: HTTP ${refreshedRes.status}`);
  const refreshedBuf = new Uint8Array(await refreshedRes.arrayBuffer());
  const refreshedSha = sha(refreshedBuf);
  log(
    `refreshed doc bytes=${refreshedBuf.byteLength} sha=${refreshedSha} ` +
      `${refreshedSha === initialSha ? "!! UNCHANGED !!" : "changed"}`,
  );

  // 7. Confirm the marker is actually in the document. `find-text` currently
  //    trips an `AttributeError: getString` on freshly-inserted tracked runs,
  //    so we dump the full paragraph listing via `text` and grep for the
  //    marker there — same ground truth, no UNO side-effect.
  const textRes = await fetch(`${BASE}/api/tools/docx-tool`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      workspaceId,
      subcommand: "text",
      args: [],
    }),
  });
  const textJson = await textRes.json();
  const stdout = (textJson?.result?.stdout ?? "") as string;
  const markerPresent = stdout.includes(marker);
  log(`text dump marker present=${markerPresent} (stdout len=${stdout.length})`);

  // Clean shutdown
  sse.close();
  await sse.done;

  // --- Verdict ---
  console.log("\n=== VERDICT ===");
  const serverOk = refreshedSha !== initialSha && markerPresent;
  console.log(`workspace:           ${workspaceId}`);
  console.log(`initial sha:         ${initialSha} (${initialBuf.byteLength} bytes)`);
  console.log(`refreshed sha:       ${refreshedSha} (${refreshedBuf.byteLength} bytes)`);
  console.log(`marker in doc:       ${markerPresent}`);
  console.log(`checkpoint seq:      ${cp.seq}`);
  console.log(`mutate → SSE:        ${elapsed}ms`);
  console.log(
    `server pipeline:     ${serverOk ? "OK — bytes changed AND marker present" : "BROKEN"}`,
  );
  if (serverOk) {
    console.log(
      "\nIf the browser still doesn't refresh, the bug is client-side:\n" +
        "  - SSE not connecting (check DevTools → Network → eventsource)\n" +
        "  - DocxPanel not firing loadDocumentBuffer (add a console.log in useWorkspaceEvents)\n" +
        "  - SuperDoc not re-rendering from loadDocumentBuffer call",
    );
  }
  process.exit(serverOk ? 0 : 1);
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
