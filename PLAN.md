# PLAN — Localhost DOCX editor + pi-style agent chat

## 1. Goal & scope

Build a **localhost app** pairing:

- **Left**: SuperDoc (`@eigenpal/docx-js-editor`) — real WYSIWYG DOCX editor, tracked changes, accept/reject, export. No Document Server, client-side only.
- **Right**: streaming agent chat matching the Reducto Editor handoff design pixel-for-pixel (tool pills, thinking dots, typewriter, composer).
- **Agent**: the `pi` ecosystem. `@mariozechner/pi-agent-core` runs the agent loop in the **browser**. Tools are defined in the browser but `execute` via HTTP to a local **Bun tool server** that has real filesystem + bash access. Same tool vocabulary as `pi-coding-agent` (bash, read, write, edit, grep, find, ls) plus a DOCX helper.

### Why this split

The user's constraints: (a) stay in the pi ecosystem, (b) bash / local filesystem access now, (c) drop in a sandbox later without rewriting the agent.

This architecture delivers all three:

- **pi stays**: `pi-agent-core` + `pi-ai` are the agent engine. Tool *schemas* mirror `pi-coding-agent`'s so behavior/prompts line up. We don't run `pi-coding-agent` the package directly because it's Node-only and CLI-shaped — we'd be forcing it through a browser UI it wasn't designed for.
- **Real FS now**: browser-side tool `execute` functions POST to `http://localhost:3000/api/tools/bash` (etc.), which shells out for real.
- **Sandbox later**: in production, `/api/tools/*` points at a sandbox runner (Docker, Fly Machines, whatever). Browser agent code and UI are unchanged. Same swap moves LibreOffice + headless-word into the sandbox too.

**In scope v1**: upload DOCX → chat → watch the agent edit it → tracked changes appear live in SuperDoc → accept/reject → export.

**Out of scope v1**: auth, multi-user, persistence across process restarts (sessions are in-memory + filesystem), cloud deploy, IndexedDB-backed key storage.

---

## 2. Why SuperDoc (locked in)

Repeating the key finding from last round so the record is consolidated:

- `editorRef.loadDocumentBuffer(buffer)` is a documented ref method → live agent checkpoints replace the doc buffer **without remount**. Selection/scroll are preserved best-effort, tracked changes stay visible.
- `mode: 'suggesting'` + `author` prop → every agent edit is a native tracked change with author attribution; SuperDoc's toolbar handles accept/reject.
- MIT, pure client-side. No Document Server, no JWT, no iframe, no Docker.
- Replaces ~600 LOC of the reference's ONLYOFFICE plumbing (`server.ts:340-929`) with a ref method call.

---

## 3. Agent architecture: browser-side `pi-agent-core`

### The pi package landscape (from `reference/pi-mono/packages/`)

- `@mariozechner/pi-ai` — LLM wrapper. Models, streaming, messages.
- `@mariozechner/pi-agent-core` — `Agent` class, transport abstraction, state, events. Browser-compatible. Depends only on pi-ai.
- `@mariozechner/pi-coding-agent` — CLI coding agent. Node-only (`bin: pi`, uses child_process, TUI, photon wasm). This is what the reference's server imports.
- `@mariozechner/pi-web-ui` — Lit + Tailwind v4 web components wrapping pi-agent-core. Good patterns to borrow; not a React library.

### The loop (what lives where)

```
  Browser (our React app)                    Local Bun server
  ┌──────────────────────────────┐          ┌──────────────────────────────┐
  │ Agent (pi-agent-core)        │          │ /api/llm/anthropic           │
  │   state.tools = [            │          │   Anthropic proxy            │
  │     bash, read, write, edit, │◄─LLM────►│   + injects ANTHROPIC_API_KEY│
  │     grep, find, ls, docxTool │          │                              │
  │   ]                          │          │ /api/tools/bash              │
  │   subscribe(event => ...)    │          │ /api/tools/read              │
  │     → drives React state     │          │ /api/tools/write             │
  │                              │          │ /api/tools/edit              │
  │ ChatPanel (our React)        │          │ /api/tools/grep              │
  │   Reducto design             │          │ /api/tools/find              │
  │                              │          │ /api/tools/ls                │
  │ SuperDoc (DocxEditor)        │          │ /api/tools/docx-tool         │
  │   loadDocumentBuffer on      │          │                              │
  │   checkpoint                 │          │ /api/workspaces/*            │
  │                              │──tool────►│   GET /doc (latest buffer)   │
  │                              │   HTTP   │   PUT /doc (from save())     │
  │                              │          │                              │
  │                              │◄──SSE────│ /api/workspaces/:id/events   │
  │                              │          │   file-watch → checkpoints   │
  └──────────────────────────────┘          └──────────────────────────────┘
                                                     │ bash, fs, headless-word
                                                     ▼
                                            workspaces/<date>_<uuid>/
                                            ├── original.docx
                                            ├── working.docx        ← agent edits here
                                            ├── document_text.current.json
                                            ├── document_structure.current.json
                                            ├── agent_notes.md
                                            ├── context_manifest.json
                                            ├── activity/*.jsonl
                                            └── docx-tool           (generated shim)
```

### Concretely

**Browser-side Agent** (`src/agent/agent.ts`):

```ts
import { Agent, defaultConvertToLlm } from '@mariozechner/pi-agent-core';
import { getModel } from '@mariozechner/pi-ai';
import { createLocalTools } from './tools';

export function createAgent(workspaceId: string) {
  return new Agent({
    initialState: {
      systemPrompt: buildSystemPrompt(),          // port reference agent.ts:391-433
      model: getModel('anthropic', 'claude-sonnet-4-5'),
      thinkingLevel: 'medium',
      messages: [],
      tools: createLocalTools(workspaceId),       // see below
    },
    convertToLlm: defaultConvertToLlm,
    streamFn: createProxyStreamFn('/api/llm/anthropic'), // proxy → server → Anthropic
  });
}
```

**Browser-side tools** (`src/agent/tools.ts`) — one thin definition per server endpoint:

```ts
import { z } from 'zod';
import type { Tool } from '@mariozechner/pi-agent-core';

const post = <T>(path: string, body: unknown): Promise<T> =>
  fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body) }).then(r => r.json());

export function createLocalTools(workspaceId: string): Tool[] {
  const ctx = { workspaceId };
  return [
    {
      name: 'bash',
      description: 'Run a bash command inside the workspace.',
      parameters: z.object({ command: z.string(), cwd: z.string().optional() }),
      execute: async (args) => post('/api/tools/bash', { ...ctx, ...args }),
    },
    // read, write, edit, grep, find, ls, docx_tool — same shape
  ];
}
```

**Server-side tool handlers** (`src/server/tools/*.ts`) borrow from the reference:

- `bash.ts` — child_process, cwd locked to `workspaceDir`, timeouts, stdout/stderr/exit-code back as JSON.
- `fs.ts` — read/write/edit/ls, path-traversal check against `workspaceDir`.
- `search.ts` — grep/find, same sandboxing.
- `docx-tool.ts` — shells out to the `./docx-tool` shim (wraps the reference's `workspace_tool.py` over headless-word). Keeps all the DOCX primitives (replace-text, insert-after, append-paragraph, get-ooxml, insert-ooxml, form-field helpers, etc.) without us reimplementing them.

**LLM proxy** (`src/server/llm.ts`) — forwards `POST /api/llm/anthropic` to `https://api.anthropic.com/v1/messages`, streaming response through. Injects `ANTHROPIC_API_KEY` from env. No key in the browser. Reason we need this at all: Anthropic doesn't serve CORS to browsers for `sk-ant-api*` keys.

### pi-web-ui: inspiration, not dependency

pi-web-ui is Lit + Tailwind v4 web components. Dropping it into a React + Reducto-themed app means mixing frameworks and losing pixel control over pills/composer layout. We **do not** import it; we **do** borrow its patterns:

- `agent.subscribe(event => ...)` as the state-sync primitive (see `pi-web-ui/README.md:186-197`).
- A *tool renderer registry* so custom tools render with custom pills (`registerToolRenderer(name, renderer)` equivalent in our codebase).
- A *message renderer registry* for custom message roles (e.g., an `artifact`-style pill).
- The `UserMessageWithAttachments` role for file uploads as context.
- Prompt-assembly shape from `pi-coding-agent`-style system prompts (reference `agent.ts:391-450`).

If we run out of runway, fallback is documented: drop pi-web-ui's `AgentInterface` into a single React container via `@lit-labs/react`; lose Reducto fidelity but ship.

---

## 4. Design inventory

### Chat panel (right) — build from `design/editor/project/{chat.jsx, app.jsx, editor-styles.css}`

Full port: `ChatPanel`, `ChatHeader`, `SessionChip` (repurposed `chat-doc-chip`), `Conversation`, `Message`, `TextBlock`, `ToolPill` (compact + detailed), `ActionResultPill` (repurposed `change-pill`), `ThinkingIndicator`, `StreamCursor`, `Composer`, `ComposerHints`, `TweaksPanel`.

Agent events → UI mapping:

| `AgentSessionEvent` (pi-agent-core) | Our React UI |
|---|---|
| `agent_start` | Clear pending assistant bubble; spinner in composer. |
| `message_start` (role: assistant) | Append empty assistant `Message`. |
| `message_update` with `text_delta` | Append to last `TextBlock`; show `StreamCursor` on the live fragment. |
| `message_update` with `tool_call_start` | Push `ToolPill state="working"` into the assistant message's blocks. Label via `formatToolExecutionLabel` (port of `reference/src/pi_docx_editor/agent.ts:168-192`). |
| `tool_execution_start` | Same as above if we hadn't seen tool_call_start yet. |
| `tool_execution_end` | Flip pill to `state="done"`; summarise result into `detail`. If result has `kind: 'change'` or `kind: 'action'`, append an `ActionResultPill`. |
| `message_end` | Drop streaming cursor. |
| `agent_end` | Re-enable composer. |
| (custom) `workspace_checkpoint` | Fetch buffer, call `editorRef.loadDocumentBuffer`. |
| (custom) `status` / `metrics` / `error` | Toast / footer / banner. |

Workspace-level events (`checkpoint`, `status`, `metrics`, `error`) arrive via an SSE channel separate from the agent loop — see §6.

### Editor panel (left) — replace, don't port

The design's Word mock (`WordTitleBar`, `RibbonTabs`, `RibbonBody`, `Ruler`, `DocumentContent`, `DocumentContentMargin`, `StatusBar`) is a prototype. We replace it entirely with SuperDoc and a thin Reducto-themed chrome:

- Custom title bar row: doc name (editable → `onDocumentNameChange`), agent status dot, "Accept all" / "Reject all" (wired to SuperDoc's bulk accept/reject), "Export" (→ `editorRef.save()` → download).
- `<DocxEditor>` with `mode`, `author`, `documentBuffer`, `showRuler`, `showOutline`, `theme` (Reducto palette).
- Empty state: drop-zone + "Open DOCX" button before a workspace exists.

---

## 5. Server API surface

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/workspaces` | Multipart: docx file. Creates `workspaces/<date>_<uuid>/`, seeds original/working DOCX, opens headless-word, enables tracked changes, returns `{ workspaceId, buffer }`. |
| GET | `/api/workspaces/:id/doc?seq=N` | Serves latest `working.docx`. `seq` cache-busts after a checkpoint. |
| PUT | `/api/workspaces/:id/doc` | Raw body = DOCX buffer from client `editorRef.save()`. Overwrites `working.docx`. Next agent turn sees the user's in-browser edits. |
| GET | `/api/workspaces/:id/events` | SSE. Emits `{ kind: 'checkpoint', seq, docxUrl, sourceTool }`, `{ kind: 'status' }`, `{ kind: 'error' }`. Connected for the lifetime of a workspace session. |
| POST | `/api/tools/bash` | Body `{ workspaceId, command, cwd?, timeoutMs? }`. Returns `{ stdout, stderr, exitCode }`. cwd is forced inside the workspace. |
| POST | `/api/tools/read` · `/write` · `/edit` · `/ls` | FS operations, path-traversal-checked against workspace root. |
| POST | `/api/tools/grep` · `/find` | Search, same sandbox. |
| POST | `/api/tools/docx-tool` | Body `{ workspaceId, subcommand, args?, stdin? }`. Executes the generated `./docx-tool` shim inside the workspace. After every mutating subcommand, a debounced checkpoint is scheduled. |
| POST | `/api/llm/anthropic` | Passthrough proxy to `api.anthropic.com/v1/messages`. Injects `ANTHROPIC_API_KEY`. Streams. |

Everything scoped to one workspace id. Requests without a matching workspace get 404.

---

## 6. Live-reload protocol (same as before, reconfirmed)

- Server watches `working.docx` and keys checkpoints off the **`tool-execution-end`** of any mutating `docx-tool` subcommand (list from `reference/src/pi_docx_editor/pipeline.ts:94-109`).
- Debounce: `DEBOUNCE_MS = 1200`, `MIN_INTERVAL_MS = 4000` (copied from reference).
- On fire: open headless-word session, `saveDocument(sessionId)`, copy to output, emit `{ kind: 'checkpoint', seq, docxUrl: '/api/workspaces/.../doc?seq=N' }` over the workspace SSE.
- Browser: fetch buffer → `editorRef.loadDocumentBuffer(buf)`. Record last-applied seq; drop stale checkpoints.
- User-side edits: `onChange` debounced 500ms → PUT `/doc`. A turn-in-progress check on the server rejects PUTs during agent turns with a clear error the UI surfaces ("agent is editing — your change was not saved").

Last-writer-wins is fine for v1. Proper merge isn't on the table.

---

## 7. Stack

| Layer | Choice |
|---|---|
| Runtime | Bun |
| Build / dev | Vite |
| App framework | Vite (client) + **Hono** (API server), both on Bun. Two tiny processes; Vite proxies `/api/*` to Hono in dev, single Bun bundle in prod. |
| UI kit | shadcn/ui + Tailwind |
| Design tokens | `design/editor/project/tokens.css` verbatim, Tailwind reads CSS vars |
| Fonts | Roobert, Reducto Serif, Berkeley Mono — copied into `public/fonts/` |
| Icons | `lucide-react` (matches `CI` set from `chat.jsx`) |
| DOCX editor | `@eigenpal/docx-js-editor` |
| Agent | `@mariozechner/pi-agent-core` + `@mariozechner/pi-ai` |
| LLM | Claude Sonnet 4.5 via Anthropic (proxy server-side; env `ANTHROPIC_API_KEY`) |
| DOCX runtime | headless-word + LibreOffice (`uv tool install headless-word`) |
| Schema | zod |

No IndexedDB key storage, no CORS proxy dialog, no SettingsDialog. On localhost the LLM key is in the server env and that's it.

System prereqs: `bun`, `uv`, `libreoffice`, Node 20+.

---

## 8. Project structure

```
docx-editor/
├── PLAN.md
├── README.md
├── package.json
├── vite.config.ts
├── tsconfig.json
├── tailwind.config.ts
├── postcss.config.cjs
├── index.html
├── workspace_tool.py                 # ported verbatim from reference
├── public/
│   ├── fonts/                        # from design/
│   └── assets/logomark.svg
├── server.ts                         # Hono entry: app.route('/api', …).serve on Bun
├── src/
│   ├── main.tsx                      # Vite client entry
│   ├── styles/
│   │   ├── tokens.css                # verbatim from design
│   │   ├── editor.css                # right-panel styles trimmed
│   │   └── layout.css                # two-panel split, SuperDoc chrome
│   ├── components/
│   │   ├── App.tsx                   # two-panel layout
│   │   ├── docx/
│   │   │   ├── DocxPanel.tsx         # SuperDoc + chrome
│   │   │   ├── DocxTitleBar.tsx
│   │   │   └── useDocxSync.ts        # debounced save + checkpoint handler
│   │   ├── chat/                     # full Reducto port — ChatPanel, Message, ToolPill, etc.
│   │   ├── TweaksPanel.tsx
│   │   ├── icons/Icon.tsx
│   │   └── ui/                       # shadcn primitives
│   ├── agent/
│   │   ├── agent.ts                  # factory: createAgent(workspaceId)
│   │   ├── tools.ts                  # browser tool definitions (execute: fetch)
│   │   ├── prompts.ts                # systemPrompt (ported from reference)
│   │   ├── labels.ts                 # formatToolExecutionLabel
│   │   ├── streamFn.ts               # proxy-aware stream fn
│   │   └── renderers.ts              # tool/message renderer registry (React)
│   ├── server/                       # imported by ../server.ts (Hono)
│   │   ├── routes/
│   │   │   ├── llm.ts                # POST /api/llm/anthropic → streaming proxy
│   │   │   ├── workspaces.ts         # POST /api/workspaces, GET/PUT /:id/doc, SSE /:id/events
│   │   │   └── tools.ts              # POST /api/tools/:name → dispatch
│   │   ├── tools/
│   │   │   ├── bash.ts
│   │   │   ├── fs.ts
│   │   │   ├── search.ts
│   │   │   └── docx-tool.ts
│   │   ├── workspace.ts              # create, seed, list, activity log
│   │   ├── headless-word.ts          # subset from reference
│   │   ├── checkpoint.ts             # debounced checkpoint + SSE writer
│   │   └── llm-proxy.ts              # Anthropic passthrough impl
│   ├── hooks/
│   │   ├── useAgent.ts               # wraps pi-agent-core Agent + React state sync
│   │   ├── useWorkspaceEvents.ts     # SSE → checkpoint dispatch
│   │   └── useDocxRef.ts
│   └── lib/
│       ├── utils.ts
│       └── types.ts                  # shared enums, PipelineEvent shape
└── workspaces/                       # runtime, created on demand
    └── <date>_<uuid>/…               # same layout as reference
```

What's lifted from reference (copy + trim):
- `workspace_tool.py` — verbatim.
- `reference/src/pi_docx_editor/headless-word.ts` → `src/server/headless-word.ts` — subset we call.
- `reference/src/pi_docx_editor/workspaces.ts` → `src/server/workspace.ts` — ID/path helpers.
- `reference/src/pi_docx_editor/agent.ts:prepareAgentWorkspace` → `src/server/workspace.ts:seedWorkspace` — keep the README_AGENT.md / HEADLESS_WORD_SKILL.md generation.
- `reference/src/pi_docx_editor/agent.ts:buildSystemPrompt/buildUserPrompt` → `src/agent/prompts.ts`.
- `reference/src/pi_docx_editor/agent.ts:formatToolExecutionLabel` → `src/agent/labels.ts`.

What's dropped:
- All ONLYOFFICE code (~600 LOC of `server.ts`).
- `runDocxWorkspaceReviewAction` — SuperDoc handles accept/reject natively.
- PDF preview rendering — SuperDoc renders pages.
- `pi-coding-agent` itself — we use pi-agent-core + our own tools that mirror its schema.

---

## 9. Implementation phases

**Phase 0 — bootstrap**
Vite + React + TS (client), Hono + Bun (`server.ts`), Vite dev proxy `/api/*` → Hono. Tokens.css + fonts in place. Tailwind wired to CSS vars. shadcn init. Dev: `bun run server` + `bun run dev` (or a `concurrently` wrapper). Dev server renders Roobert.

**Phase 1 — chat visual port**
Port all right-panel components from the design (React + Reducto classes). Seed with scripted conversation from `chat.jsx:SCRIPTED_RESPONSES` so the page looks identical to the design before any agent wiring.

**Phase 2 — SuperDoc**
`DocxPanel` with `<DocxEditor mode="editing" author="You" />`. Custom title bar row (doc name, accept-all, reject-all, export). Drag-drop / file input → ArrayBuffer → `loadDocumentBuffer`. Theme to Reducto palette.

**Phase 3 — server + workspaces**
`src/server/workspace.ts:createWorkspace` (port from reference). `POST /api/workspaces`, `GET/PUT /api/workspaces/:id/doc`. Seed README_AGENT.md / HEADLESS_WORD_SKILL.md / `docx-tool` shim. Activity log writer.

**Phase 4 — browser Agent + tool endpoints**
`src/agent/agent.ts`, `src/agent/tools.ts`, `src/agent/prompts.ts`, `src/agent/streamFn.ts`. Server tool handlers (`bash`, `fs`, `search`, `docx-tool`). LLM proxy. `useAgent` hook maps `agent.subscribe` events to React state. Rough chat works: prompt → Claude → streaming text + tool calls.

**Phase 5 — tool/message renderers**
Port pi-web-ui's renderer-registry idea to React. `registerToolRenderer('bash', BashPillRenderer)`, etc. Default renderer → compact ToolPill; `bash` → shows command + optional output body (detailed variant); `docx-tool` → change/action pill when the subcommand is mutating. Label formatter from reference.

**Phase 6 — live-reload loop**
`src/server/checkpoint.ts` + SSE endpoint. File watcher keyed off mutating docx-tool calls. `useWorkspaceEvents` hook dispatches checkpoints → `editorRef.loadDocumentBuffer`. Test with "append a paragraph" → redline appears without reload.

**Phase 7 — polish + browser smoke test**
Empty state, error banner, metrics footer, composer hints, TweaksPanel (pill density + agent authoring mode toggle). Manual test: upload → chat → live redline → accept → export. Report exactly what I did/didn't verify.

