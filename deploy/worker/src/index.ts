import { Sandbox } from "e2b";

interface Env {
  SANDBOX_MAP: KVNamespace;
  E2B_API_KEY: string;
  ANTHROPIC_API_KEY: string;
  E2B_TEMPLATE: string;
}

interface SandboxEntry {
  sandboxId: string;
  host: string;
}

const SANDBOX_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

async function getSandboxEntry(
  workspaceId: string,
  env: Env
): Promise<SandboxEntry | null> {
  const raw = await env.SANDBOX_MAP.get(workspaceId);
  if (!raw) return null;
  return JSON.parse(raw) as SandboxEntry;
}

async function storeSandboxEntry(
  workspaceId: string,
  entry: SandboxEntry,
  env: Env
): Promise<void> {
  await env.SANDBOX_MAP.put(workspaceId, JSON.stringify(entry), {
    expirationTtl: SANDBOX_TIMEOUT_MS / 1000,
  });
}

async function createSandboxForWorkspace(
  env: Env
): Promise<{ sandbox: Sandbox; host: string }> {
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY secret is not configured. Run: wrangler secret put ANTHROPIC_API_KEY");
  }

  const sandboxEnvs: Record<string, string> = {
    ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
  };

  const sandbox = await Sandbox.create(env.E2B_TEMPLATE, {
    timeoutMs: SANDBOX_TIMEOUT_MS,
    envs: sandboxEnvs,
    apiKey: env.E2B_API_KEY,
  });

  const PATH =
    "/root/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

  // Start the headless-word daemon BEFORE the server — the server's
  // ensureDaemonRunning() spawns child processes that need the daemon
  // already running, and PATH resolution can fail in the bundled context.
  await sandbox.commands.run("headless-word start", {
    user: "root",
    envs: { PATH },
    timeoutMs: 60_000,
  });

  // Start the Bun server inside the sandbox
  await sandbox.commands.run(
    "cd /home/user/app && /root/.bun/bin/bun run server.js > /tmp/server.log 2>&1",
    {
      background: true,
      envs: {
        ...sandboxEnvs,
        PORT: "3001",
        PATH,
      },
      user: "root",
    }
  );

  const host = sandbox.getHost(3001);

  // Wait for the server to be healthy
  let healthy = false;
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`https://${host}/api/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) {
        healthy = true;
        break;
      }
    } catch {
      // Server not ready yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  if (!healthy) {
    // Try to get logs for debugging
    try {
      const logs = await sandbox.commands.run("cat /tmp/server.log", {
        timeoutMs: 5000,
      });
      console.error("Server failed to start. Logs:", logs.stdout, logs.stderr);
    } catch {
      // ignore
    }
    await Sandbox.kill(sandbox.sandboxId, { apiKey: env.E2B_API_KEY });
    throw new Error("Sandbox server failed to start within 30 seconds");
  }

  return { sandbox, host };
}

function extractWorkspaceIdFromPath(pathname: string): string | null {
  const match = pathname.match(
    /\/api\/workspaces\/(\d{4}-\d{2}-\d{2}_[a-f0-9-]{36})/
  );
  return match ? match[1] : null;
}

async function extractWorkspaceIdFromBody(
  request: Request
): Promise<{ workspaceId: string | null; bodyText: string }> {
  const bodyText = await request.text();
  try {
    const parsed = JSON.parse(bodyText);
    if (typeof parsed.workspaceId === "string") {
      return { workspaceId: parsed.workspaceId, bodyText };
    }
  } catch {
    // not JSON
  }
  return { workspaceId: null, bodyText };
}

async function proxyRequest(
  request: Request,
  host: string,
  overrideBody?: string
): Promise<Response> {
  const url = new URL(request.url);
  const targetUrl = `https://${host}${url.pathname}${url.search}`;

  const headers = new Headers(request.headers);
  headers.set("Host", host);
  headers.delete("cf-connecting-ip");
  headers.delete("cf-ray");
  headers.delete("cf-visitor");
  headers.delete("cf-ipcountry");

  const init: RequestInit = {
    method: request.method,
    headers,
  };

  if (request.method !== "GET" && request.method !== "HEAD") {
    if (overrideBody !== undefined) {
      init.body = overrideBody;
    } else {
      init.body = request.body;
      // @ts-expect-error duplex needed for streaming body
      init.duplex = "half";
    }
  }

  const response = await fetch(targetUrl, init);

  const responseHeaders = new Headers(response.headers);
  responseHeaders.delete("access-control-allow-origin");
  responseHeaders.delete("access-control-allow-methods");
  responseHeaders.delete("access-control-allow-headers");
  responseHeaders.delete("access-control-allow-credentials");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
}

async function handleCreateWorkspace(
  request: Request,
  env: Env
): Promise<Response> {
  const { sandbox, host } = await createSandboxForWorkspace(env);

  // Proxy the multipart upload to the sandbox
  const response = await proxyRequest(request, host);

  if (!response.ok) {
    await Sandbox.kill(sandbox.sandboxId, { apiKey: env.E2B_API_KEY });
    return response;
  }

  const body = (await response.json()) as {
    ok: boolean;
    workspaceId?: string;
    error?: string;
  };
  if (!body.ok || !body.workspaceId) {
    await Sandbox.kill(sandbox.sandboxId, { apiKey: env.E2B_API_KEY });
    return Response.json(body, { status: 400 });
  }

  await storeSandboxEntry(body.workspaceId, {
    sandboxId: sandbox.sandboxId,
    host,
  }, env);

  return Response.json(body);
}

async function handleApiRequest(
  request: Request,
  env: Env,
  pathname: string
): Promise<Response> {
  // Health check — respond directly
  if (pathname === "/api/health") {
    return Response.json({ ok: true });
  }

  // Create workspace — needs new sandbox
  if (pathname === "/api/workspaces" && request.method === "POST") {
    return handleCreateWorkspace(request, env);
  }

  // All other routes need a workspace ID to find the sandbox
  let workspaceId = extractWorkspaceIdFromPath(pathname);
  let bodyText: string | undefined;

  if (!workspaceId && pathname.startsWith("/api/chat/")) {
    // Chat routes have workspaceId in the JSON body
    const extracted = await extractWorkspaceIdFromBody(request);
    workspaceId = extracted.workspaceId;
    bodyText = extracted.bodyText;
  }

  if (!workspaceId) {
    return Response.json(
      { ok: false, error: "Could not determine workspace" },
      { status: 400 }
    );
  }

  const entry = await getSandboxEntry(workspaceId, env);
  if (!entry) {
    return Response.json(
      { ok: false, error: "Workspace not found or sandbox expired" },
      { status: 404 }
    );
  }

  return proxyRequest(request, entry.host, bodyText);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods":
            "GET, POST, PUT, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    // Root → redirect to /editor
    if (pathname === "/" || pathname === "") {
      return Response.redirect(new URL("/editor/", url).toString(), 302);
    }

    // API routes → proxy to E2B sandbox
    if (pathname.startsWith("/api/")) {
      try {
        const response = await handleApiRequest(request, env, pathname);
        const headers = new Headers(response.headers);
        headers.set("Access-Control-Allow-Origin", "*");
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      } catch (err) {
        console.error("API error:", err);
        return Response.json(
          {
            ok: false,
            error:
              err instanceof Error ? err.message : "Internal server error",
          },
          { status: 500 }
        );
      }
    }

    // Everything else — static assets handled by Wrangler [assets] config.
    // This code only runs for paths that don't match a static file.
    // For /editor/* SPA fallback, serve index.html.
    if (pathname.startsWith("/editor")) {
      return new Response(null, {
        status: 302,
        headers: { Location: "/editor/" },
      });
    }

    return new Response("Not found", { status: 404 });
  },
};
