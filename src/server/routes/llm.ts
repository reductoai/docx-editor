// Server-side LLM proxy. Keeps the Anthropic API key on the server, takes
// the request body from the browser verbatim, and forwards it to the
// Anthropic Messages API. Streams the SSE response back to the client.

import { Hono } from "hono";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

export const llmRouter = new Hono();

llmRouter.post("/anthropic", async (c) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return c.json({ error: "ANTHROPIC_API_KEY not set" }, 500);
  }

  // Pass the raw body through so provider-specific fields (tools, thinking,
  // beta flags, etc.) round-trip without schema coupling on this side.
  let rawBody: string;
  try {
    rawBody = await c.req.text();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: `unable to read request body: ${message}` }, 400);
  }

  let upstream: Response;
  try {
    upstream = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        // fine-grained tool streaming matches pi-ai's default and enables
        // incremental `input_json_delta` events for tool calls.
        "anthropic-beta": "fine-grained-tool-streaming-2025-05-14",
      },
      body: rawBody,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: `upstream fetch failed: ${message}` }, 502);
  }

  if (!upstream.ok) {
    // Forward Anthropic error responses verbatim (as JSON) with the same status.
    const status = upstream.status as 400 | 401 | 403 | 404 | 429 | 500 | 502 | 503;
    const text = await upstream.text();
    // Best-effort: return the body as-is if JSON, else wrap it.
    try {
      const parsed = JSON.parse(text);
      return c.json(parsed, status);
    } catch {
      return c.json({ error: text || upstream.statusText }, status);
    }
  }

  if (!upstream.body) {
    return c.json({ error: "upstream returned empty body" }, 502);
  }

  // Stream SSE chunks back to the browser unchanged. Hono will handle
  // chunked transfer encoding under Bun.
  const contentType =
    upstream.headers.get("content-type") ?? "text/event-stream";
  return new Response(upstream.body, {
    status: 200,
    headers: {
      "content-type": contentType,
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
});
