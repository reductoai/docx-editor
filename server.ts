import { Hono } from "hono";
import { logger } from "hono/logger";
import { cors } from "hono/cors";

const app = new Hono();

app.use("*", logger());
app.use(
  "*",
  cors({
    origin: ["http://localhost:5173"],
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    credentials: true,
  })
);

app.get("/api/health", (c) => c.json({ ok: true }));

// Routers for workspaces / tools / llm are mounted by later units.
// Lazy-imported so bootstrapping the server doesn't require them.
try {
  const { workspacesRouter } = await import("./src/server/routes/workspaces");
  app.route("/api/workspaces", workspacesRouter);
} catch (err) {
  console.warn("[server] workspaces router not mounted:", (err as Error).message);
}

try {
  const { chatRouter } = await import("./src/server/routes/chat");
  app.route("/api/chat", chatRouter);
} catch (err) {
  console.warn("[server] chat router not mounted:", (err as Error).message);
}

const port = Number(process.env.PORT ?? 3001);

export default {
  port,
  fetch: app.fetch,
  // Bun's default idleTimeout is 10s, which kills long-lived SSE
  // connections (`/api/workspaces/:id/events`). 0 disables the timeout
  // entirely; with heartbeats every 15s this keeps SSE open indefinitely.
  idleTimeout: 0,
};

console.log(`[server] listening on http://localhost:${port}`);
