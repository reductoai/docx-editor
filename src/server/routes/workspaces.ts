import { Hono } from "hono";
import { readFile, writeFile } from "node:fs/promises";
import {
  createWorkspace,
  getWorkspace,
  isTurnActive,
  isValidWorkspaceId,
} from "../workspace";
import { appendActivity } from "../activity";
import { publish, subscribe } from "../sse";
import { ensureCheckpointState, getCurrentSeq } from "../checkpoint";
import type { WorkspaceEvent } from "../../lib/types";

export const workspacesRouter = new Hono();

// ---------------------------------------------------------------------------
// POST /api/workspaces — create
// ---------------------------------------------------------------------------
workspacesRouter.post("/", async (c) => {
  let form: FormData;
  try {
    form = await c.req.formData();
  } catch (err) {
    return c.json(
      {
        ok: false,
        error: `Invalid multipart form: ${
          err instanceof Error ? err.message : String(err)
        }`,
      },
      400,
    );
  }
  const file = form.get("file");
  if (!(file instanceof File)) {
    return c.json(
      { ok: false, error: "Missing `file` field (multipart/form-data)." },
      400,
    );
  }

  const originalName =
    typeof file.name === "string" && file.name.length > 0
      ? file.name
      : "document.docx";

  const workspace = await createWorkspace({ file, originalName });

  // Kick off checkpoint state (starts fs.watch).
  await ensureCheckpointState(workspace.id);

  await appendActivity(workspace.id, {
    type: "workspace_created",
    originalName,
  }).catch((err) => {
    console.warn("[workspaces] activity append failed:", err.message);
  });

  return c.json({
    ok: true,
    workspaceId: workspace.id,
  });
});

// ---------------------------------------------------------------------------
// GET /api/workspaces/:id/doc — download latest working.docx
// ---------------------------------------------------------------------------
workspacesRouter.get("/:id/doc", async (c) => {
  const id = c.req.param("id");
  if (!isValidWorkspaceId(id)) {
    return c.json({ ok: false, error: "Invalid workspace id." }, 400);
  }
  const workspace = await getWorkspace(id);
  if (!workspace) {
    return c.json({ ok: false, error: "Unknown workspace." }, 404);
  }
  try {
    const bytes = await readFile(workspace.workingPath);
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Content-Length": String(bytes.byteLength),
        "Cache-Control": "no-cache",
        "Content-Disposition": `inline; filename="${encodeURIComponent(
          workspace.originalName,
        )}"`,
      },
    });
  } catch (err) {
    return c.json(
      {
        ok: false,
        error: `Failed to read working document: ${
          err instanceof Error ? err.message : String(err)
        }`,
      },
      500,
    );
  }
});

// Cap on raw body uploads to PUT /:id/doc. DOCX round-trips are small; this
// protects against accidental or malicious oversize uploads.
const MAX_DOC_PUT_BYTES = 50 * 1024 * 1024;

// ---------------------------------------------------------------------------
// PUT /api/workspaces/:id/doc — raw body, overwrite working.docx
// ---------------------------------------------------------------------------
workspacesRouter.put("/:id/doc", async (c) => {
  const id = c.req.param("id");
  if (!isValidWorkspaceId(id)) {
    return c.json({ ok: false, error: "Invalid workspace id." }, 400);
  }
  const workspace = await getWorkspace(id);
  if (!workspace) {
    return c.json({ ok: false, error: "Unknown workspace." }, 404);
  }
  if (isTurnActive(id)) {
    return c.json({ ok: false, error: "turn-in-progress" }, 409);
  }

  // Fast reject: if the client declares a body larger than our cap, 413 before
  // we allocate anything.
  const contentLengthHeader = c.req.header("content-length");
  if (contentLengthHeader) {
    const declared = Number(contentLengthHeader);
    if (Number.isFinite(declared) && declared > MAX_DOC_PUT_BYTES) {
      return c.json({ error: "request body too large" }, 413);
    }
  }

  const buffer = await c.req.arrayBuffer();
  if (!buffer || buffer.byteLength === 0) {
    return c.json({ ok: false, error: "Empty request body." }, 400);
  }
  // Belt-and-suspenders: also check after reading in case Content-Length was
  // missing or lied about the real size.
  if (buffer.byteLength > MAX_DOC_PUT_BYTES) {
    return c.json({ error: "request body too large" }, 413);
  }

  await writeFile(workspace.workingPath, Buffer.from(buffer));

  await appendActivity(id, {
    type: "user_doc_overwrite",
    bytes: buffer.byteLength,
  }).catch(() => undefined);

  // Ensure a checkpoint state exists for this workspace even if the user
  // PUTs before any other activity (fs.watch picks up the write anyway, but
  // this makes the behavior deterministic).
  await ensureCheckpointState(id);

  return c.json({ ok: true, bytes: buffer.byteLength });
});

// ---------------------------------------------------------------------------
// GET /api/workspaces/:id/events — SSE stream
// ---------------------------------------------------------------------------
workspacesRouter.get("/:id/events", async (c) => {
  const id = c.req.param("id");
  if (!isValidWorkspaceId(id)) {
    return c.json({ ok: false, error: "Invalid workspace id." }, 400);
  }
  const workspace = await getWorkspace(id);
  if (!workspace) {
    return c.json({ ok: false, error: "Unknown workspace." }, 404);
  }

  // Make sure checkpoint state exists before we subscribe so fs.watch is live.
  await ensureCheckpointState(id);

  const encoder = new TextEncoder();
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
  let unsubscribe: (() => void) | null = null;

  const write = (chunk: string): boolean => {
    if (closed || !controllerRef) return false;
    try {
      controllerRef.enqueue(encoder.encode(chunk));
      return true;
    } catch {
      closed = true;
      return false;
    }
  };

  const send = (event: WorkspaceEvent) => {
    write(`event: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`);
  };

  const teardown = () => {
    if (closed) return;
    closed = true;
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
    try {
      controllerRef?.close();
    } catch {
      // already closed
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      // Opening comment so proxies don't buffer.
      write(": connected\n\n");

      // Send an initial status + the current seq so new subscribers can align.
      const statusEvent: WorkspaceEvent = {
        kind: "status",
        message: `subscribed seq=${getCurrentSeq(id)}`,
      };
      write(`event: status\ndata: ${JSON.stringify(statusEvent)}\n\n`);

      unsubscribe = subscribe(id, (event) => {
        send(event);
      });

      heartbeat = setInterval(() => {
        write(`: heartbeat ${Date.now()}\n\n`);
      }, 15_000);
    },
    cancel() {
      teardown();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "X-Workspace-Id": id,
    },
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/workspaces/:id — stub
// ---------------------------------------------------------------------------
workspacesRouter.delete("/:id", async (c) => {
  const id = c.req.param("id");
  if (!isValidWorkspaceId(id)) {
    return c.json({ ok: false, error: "Invalid workspace id." }, 400);
  }
  const workspace = await getWorkspace(id);
  if (!workspace) {
    return c.json({ ok: false, error: "Unknown workspace." }, 404);
  }
  // Optional: nothing to tear down on disk for now; just acknowledge.
  // (Unit 6 may want to close agent sessions here.)
  publish(id, {
    kind: "status",
    message: "workspace-closed",
  });
  return c.json({ ok: true });
});
