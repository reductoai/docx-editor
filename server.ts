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
  const { toolsRouter } = await import("./src/server/routes/tools");
  app.route("/api/tools", toolsRouter);
} catch (err) {
  console.warn("[server] tools router not mounted:", (err as Error).message);
}

try {
  const { llmRouter } = await import("./src/server/routes/llm");
  app.route("/api/llm", llmRouter);
} catch (err) {
  console.warn("[server] llm router not mounted:", (err as Error).message);
}

const port = Number(process.env.PORT ?? 3000);

export default {
  port,
  fetch: app.fetch,
};

console.log(`[server] listening on http://localhost:${port}`);
