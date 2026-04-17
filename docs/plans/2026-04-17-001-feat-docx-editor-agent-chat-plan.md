---
title: Localhost DOCX Editor with pi-style Agent Chat
type: feat
status: active
date: 2026-04-17
origin: PLAN.md
---

# Localhost DOCX Editor with pi-style Agent Chat

## Overview

Build a localhost app pairing SuperDoc DOCX editor (left) with a streaming agent chat (right) that matches the Reducto Editor design pixel-for-pixel. Agent uses `@mariozechner/pi-agent-core` in the browser with tool `execute` functions calling a local Bun/Hono tool server that has real filesystem + bash access. Live tracked-change checkpoints flow back via SSE → `editorRef.loadDocumentBuffer`.

See [PLAN.md](../../PLAN.md) for the full architecture writeup — this plan is the execution roadmap derived from it.

## Problem Frame

User wants a pi-ecosystem DOCX editor with a chat-driven agent that can bash, read, write, edit, grep, find, ls, and run `docx-tool` on the working document. Tracked changes must appear live in a WYSIWYG editor. Architecture must be swappable to a sandbox later without rewriting the agent.

## Requirements Trace

- R1. **SuperDoc-based editor** with tracked changes, accept/reject, export, live buffer reload.
- R2. **pi-agent-core in the browser**, streaming, tool-calling, subscribing events → React state.
- R3. **Bun + Hono server** exposing `/api/tools/*`, `/api/workspaces/*`, `/api/llm/anthropic` passthrough.
- R4. **Workspace model** mirroring reference (`original.docx`, `working.docx`, `agent_notes.md`, activity log, `docx-tool` shim).
- R5. **Live-reload loop** — mutating `docx-tool` calls → debounced checkpoint → SSE → `loadDocumentBuffer`.
- R6. **Chat UI pixel-parity** with `design/editor/project/chat.jsx` (tool pills, thinking dots, typewriter, composer, tweaks panel).
- R7. **No browser-side API key storage.** `ANTHROPIC_API_KEY` lives in server env.

## Scope Boundaries

- No auth, no multi-user, no persistence across process restarts beyond the filesystem workspaces.
- No cloud deploy. Localhost only.
- No IndexedDB key storage or SettingsDialog.
- No PDF preview, no ONLYOFFICE, no running `pi-coding-agent` package directly.

## Context & Research

### Relevant Code and Patterns

- `reference/src/pi_docx_editor/agent.ts` — source for `buildSystemPrompt`, `buildUserPrompt`, `formatToolExecutionLabel`, `prepareAgentWorkspace`.
- `reference/src/pi_docx_editor/pipeline.ts` — source for the mutating-subcommand list + debounce constants (`DEBOUNCE_MS = 1200`, `MIN_INTERVAL_MS = 4000`).
- `reference/src/pi_docx_editor/workspaces.ts` — workspace ID/path helpers, seeding.
- `reference/src/pi_docx_editor/headless-word.ts` — subset of session mgmt.
- `reference/src/pi_docx_editor/workspace_tool.py` — ported verbatim.
- `reference/pi-mono/packages/agent/` — `Agent` class, `defaultConvertToLlm`, events.
- `reference/pi-mono/packages/web-ui/` — renderer-registry pattern, subscribe pattern.
- `design/editor/project/chat.jsx` — chat component vocabulary.
- `design/editor/project/tokens.css` — design tokens (copy verbatim).
- `design/editor/project/editor-styles.css` — right-panel styles to port.

## Key Technical Decisions

- **SuperDoc over Document Server / ONLYOFFICE.** Docuemnted `editorRef.loadDocumentBuffer(buffer)` + `mode: 'suggesting'` + `author` gives us live tracked-change checkpoints, native accept/reject, no server dependency.
- **Browser-side `pi-agent-core`, server-side tool `execute`.** Tool *schemas* live in the browser (matching `pi-coding-agent` vocab); each `execute` is a `fetch('/api/tools/<name>')`. Enables sandbox swap later.
- **React + Reducto theme, not `pi-web-ui`.** pi-web-ui is Lit; porting to React avoids framework mixing. We borrow patterns (subscribe, renderer registry) but write React components.
- **Hono + Bun for the server.** Two tiny processes in dev (Vite client, Hono server); single bundle in prod. Vite proxies `/api/*` → Hono.
- **LLM proxy server-side.** Keeps `ANTHROPIC_API_KEY` off the browser; bypasses Anthropic CORS restriction.
- **Claude Sonnet 4.5** as the default model.
- **zod** for tool parameter schemas.
- **shadcn/ui + Tailwind**, Tailwind reads CSS vars from `tokens.css`.

## Open Questions

### Resolved During Planning

- *Do we ship pi-coding-agent?* — No; it's Node/CLI-only. We mirror its tool vocabulary and system prompt instead.
- *Where does the LLM key live?* — Server env. Proxy route only.
- *Do we integrate pi-web-ui?* — No; we re-implement its subscribe/renderer patterns in React.

### Deferred to Implementation

- Exact pattern for the React renderer registry (direct map vs. context) — decide when porting chat components.
- Whether `onChange` debouncing on the SuperDoc side needs its own buffer-diff check (depends on SuperDoc's change-event cadence in practice).
- Handling of partial `tool_execution_start` events when `message_update.tool_call_start` doesn't fire — decide when wiring `useAgent`.

## Implementation Units

- [ ] **Unit 1: Project bootstrap — Bun + Vite + Hono + Tailwind**

  **Goal:** Empty two-pane shell renders with Roobert and the Reducto palette.

  **Requirements:** R3, R6 (foundation only).

  **Dependencies:** None.

  **Files:**
  - Create: `package.json`, `bunfig.toml`, `vite.config.ts`, `tsconfig.json`, `tailwind.config.ts`, `postcss.config.cjs`, `index.html`, `server.ts`, `src/main.tsx`, `src/components/App.tsx`, `src/styles/tokens.css` (copied verbatim from `design/editor/project/tokens.css`), `src/styles/editor.css`, `src/styles/layout.css`, `public/fonts/*` (copied from `design/editor/project/fonts/`), `public/assets/logomark.svg`.
  - Scripts: `bun run dev` starts Hono on :3000 and Vite on :5173 with `/api/*` proxy.

  **Approach:**
  - Use `hono` with `@hono/node-server` or Bun's built-in serve. Single `server.ts` mounts `/api` router (placeholder until units 3–5).
  - Tailwind config reads CSS custom properties from `tokens.css` so palette drift is impossible.
  - shadcn init with the default style; we override with the Reducto palette via tokens.

  **Patterns to follow:**
  - `design/editor/project/Editor.html` for typography setup (fonts declared in `tokens.css`).

  **Test scenarios:**
  - Happy path: `bun run dev` boots, `http://localhost:5173` returns the shell with Roobert loading from `/fonts/`.
  - Happy path: `curl http://localhost:5173/api/health` proxies to Hono and returns 200.
  - Test expectation: smoke only — no automated tests this phase.

  **Verification:**
  - Dev server loads with no console errors; fonts render; `/api/health` reachable through Vite proxy.

- [ ] **Unit 2: Chat panel visual port (right pane)**

  **Goal:** Pixel-accurate port of the chat experience from the design, driven by a scripted response array (no agent wiring yet).

  **Requirements:** R6.

  **Dependencies:** Unit 1.

  **Files:**
  - Create: `src/components/chat/ChatPanel.tsx`, `ChatHeader.tsx`, `SessionChip.tsx`, `Conversation.tsx`, `Message.tsx`, `TextBlock.tsx`, `ToolPill.tsx`, `ActionResultPill.tsx`, `ThinkingIndicator.tsx`, `StreamCursor.tsx`, `Composer.tsx`, `ComposerHints.tsx`, `TweaksPanel.tsx`, `icons/Icon.tsx`.
  - Create: `src/components/chat/scripted.ts` — ports `SCRIPTED_RESPONSES` from `design/editor/project/chat.jsx`.
  - Create: `src/components/ui/*` — shadcn primitives used (button, textarea, scroll-area, tooltip).
  - Modify: `src/styles/editor.css` — trim right-panel rules from `design/editor/project/editor-styles.css`.
  - Modify: `src/components/App.tsx` — mount `<ChatPanel>` in right pane.

  **Approach:**
  - Port all component markup and classes 1:1 from `chat.jsx`. Keep Reducto class names so the CSS from `editor-styles.css` applies directly.
  - Messages come from a local React state seeded with `scripted.ts`; Composer `onSubmit` pushes the next scripted assistant response (with simulated streaming).
  - Typewriter streaming is implemented with `useEffect` + timed splits so we can reuse the same primitive when real streaming arrives.

  **Patterns to follow:**
  - `design/editor/project/chat.jsx`, `app.jsx`, `editor-styles.css`.

  **Test scenarios:**
  - Happy path: submitting any prompt shows the thinking dots → typewritered assistant response with a tool pill and change pill (scripted).
  - Edge case: long message auto-scrolls; Composer disables while streaming.
  - Integration: toggling TweaksPanel toggles pill density CSS class.

  **Verification:**
  - Visual diff against the design screenshot is within ±2px on spacing/typography; all pills render with correct color tokens.

- [ ] **Unit 3: DOCX panel with SuperDoc (left pane)**

  **Goal:** SuperDoc editor renders an uploaded DOCX with tracked-changes mode, Reducto-themed title bar, drop-zone empty state.

  **Requirements:** R1.

  **Dependencies:** Unit 1.

  **Files:**
  - Create: `src/components/docx/DocxPanel.tsx`, `DocxTitleBar.tsx`, `useDocxSync.ts`, `useDocxRef.ts`.
  - Modify: `src/components/App.tsx` — left pane hosts `<DocxPanel>`.
  - Install: `@eigenpal/docx-js-editor`.

  **Approach:**
  - `DocxEditor` with `mode="suggesting"`, `author="You"`, `documentBuffer`, `showRuler`, `showOutline`, theme bound to Reducto palette via CSS vars.
  - Custom title bar: editable doc name, agent status dot, Accept All, Reject All, Export. Accept/Reject wired to SuperDoc's bulk toolbar actions.
  - Empty state: drop-zone + "Open DOCX" button. On drop/select, read ArrayBuffer, call `loadDocumentBuffer`. No server round-trip yet.
  - `useDocxRef` exposes `editorRef` so later units can call `loadDocumentBuffer` / `save`.

  **Patterns to follow:**
  - `@eigenpal/docx-js-editor` README for ref methods; don't remount on buffer changes.

  **Test scenarios:**
  - Happy path: drop a DOCX → renders with tracked-changes enabled.
  - Happy path: Export triggers browser download of the current buffer.
  - Edge case: dropping a non-DOCX shows an inline error.
  - Integration: doc-name edit persists in component state and passes through `onDocumentNameChange`.

  **Verification:**
  - Upload a DOCX; tracked changes exist; accept/reject all works; export downloads correct bytes.

- [ ] **Unit 4: Workspace server + DOCX I/O**

  **Goal:** Server can create a workspace from an uploaded DOCX, serve the working buffer, accept pushes from the client, and emit an SSE stream.

  **Requirements:** R3, R4, R5 (partial).

  **Dependencies:** Unit 1.

  **Files:**
  - Create: `src/server/routes/workspaces.ts`, `src/server/workspace.ts`, `src/server/headless-word.ts` (subset from reference), `src/server/checkpoint.ts`, `src/server/activity.ts`, `src/server/sse.ts`.
  - Create: `workspace_tool.py` (verbatim copy from `reference/src/pi_docx_editor/workspace_tool.py`).
  - Modify: `server.ts` — mount `app.route('/api/workspaces', workspacesRouter)`.
  - Create: `src/lib/types.ts` — `WorkspaceEvent`, `CheckpointPayload`, shared shapes.

  **Approach:**
  - `POST /api/workspaces` multipart: write `original.docx` + `working.docx`, run `prepareAgentWorkspace` (ported), return `{ workspaceId, buffer }`.
  - `GET /api/workspaces/:id/doc?seq=N` streams latest `working.docx`.
  - `PUT /api/workspaces/:id/doc` accepts raw body → overwrites `working.docx`. Rejects during an in-flight agent turn with a structured error the UI can show.
  - `GET /api/workspaces/:id/events` SSE — per-workspace pub/sub held in-memory; emits `checkpoint`, `status`, `error`.
  - `checkpoint.ts`: file watcher on `working.docx` + explicit trigger from `docx-tool` endpoint. Debounce `DEBOUNCE_MS=1200`, min interval `MIN_INTERVAL_MS=4000`. On fire: open headless-word session, `saveDocument`, copy buffer to output, bump `seq`, publish `{ kind: 'checkpoint', seq, docxUrl }`.

  **Patterns to follow:**
  - `reference/src/pi_docx_editor/pipeline.ts` for debounce + mutating-subcommand list.
  - `reference/src/pi_docx_editor/workspaces.ts` for seeding.
  - `reference/src/pi_docx_editor/headless-word.ts` for session mgmt.

  **Test scenarios:**
  - Happy path: POST a DOCX → returns workspaceId; GET `/doc` returns identical bytes.
  - Happy path: PUT `/doc` with a modified buffer → next GET returns new bytes.
  - Edge case: missing/unknown workspaceId → 404.
  - Edge case: path traversal attempt in workspaceId → 400.
  - Integration: open SSE → touch `working.docx` → receive `checkpoint` event within debounce window.
  - Error path: PUT during an active turn → returns `{ error: 'turn-in-progress' }` with a status code the UI can display.

  **Verification:**
  - `curl`-based smoke: create → get → put → get matches; SSE receives a checkpoint on file change.

- [ ] **Unit 5: Tool endpoints — bash, fs, search, docx-tool**

  **Goal:** Server exposes all agent tool endpoints scoped to a workspace, with path-traversal protection and a debounced checkpoint trigger on mutating `docx-tool` subcommands.

  **Requirements:** R2, R3, R4, R5.

  **Dependencies:** Unit 4.

  **Files:**
  - Create: `src/server/routes/tools.ts`, `src/server/tools/bash.ts`, `src/server/tools/fs.ts`, `src/server/tools/search.ts`, `src/server/tools/docx-tool.ts`.
  - Modify: `server.ts` — mount `app.route('/api/tools', toolsRouter)`.
  - Create: `src/server/sandbox.ts` — `resolveWithinWorkspace(workspaceId, relPath)` helper.

  **Approach:**
  - Every handler takes `{ workspaceId, ... }`; resolves paths through the sandbox helper; returns JSON `{ ok: true, result }` or `{ ok: false, error }`.
  - `bash` uses `child_process.spawn` with `cwd` locked to the workspace; enforces timeout; streams stdout/stderr captured into the response; no shell expansion outside the workspace.
  - `fs.read/write/edit/ls` — straight `node:fs/promises`. `edit` is the reference's `str_replace`-style contract.
  - `search.grep/find` — spawns `rg` and `fd` inside the workspace.
  - `docx-tool` runs the generated `./docx-tool` shim with provided subcommand/args/stdin. After mutating subcommands (list ported from `reference/pipeline.ts:94-109`) it triggers a debounced checkpoint via `checkpoint.ts`.

  **Patterns to follow:**
  - Reference `server.ts` tool handlers (trim to what we need).
  - zod schemas per endpoint in `src/lib/tool-schemas.ts` so client and server share the contract.

  **Test scenarios:**
  - Happy path: each endpoint executes the expected operation and returns a structured result.
  - Edge case: `bash` with cwd escape (`../../`) → 400.
  - Edge case: `fs.write` to a path outside workspace → 400.
  - Error path: `bash` timeout → returns exitCode + truncation marker.
  - Integration: `docx-tool replace-text` mutates `working.docx`, checkpoint fires on the SSE stream with `sourceTool: 'docx-tool'`.

  **Verification:**
  - `curl`-based smoke suite passes for each endpoint; sandbox rejects out-of-bounds paths.

- [ ] **Unit 6: Browser agent — pi-agent-core + tools + LLM proxy**

  **Goal:** Real agent loop runs in the browser, streams Claude responses, calls tools against the workspace, and wires `agent.subscribe` events into React state.

  **Requirements:** R2, R6, R7.

  **Dependencies:** Units 2, 3, 4, 5.

  **Files:**
  - Create: `src/agent/agent.ts`, `src/agent/tools.ts`, `src/agent/prompts.ts`, `src/agent/labels.ts`, `src/agent/streamFn.ts`, `src/agent/renderers.ts`.
  - Create: `src/server/routes/llm.ts`, `src/server/llm-proxy.ts`.
  - Create: `src/hooks/useAgent.ts`.
  - Modify: `server.ts` — mount `/api/llm/anthropic` proxy.
  - Modify: `src/components/chat/ChatPanel.tsx` — swap scripted driver for `useAgent`.
  - Install: `@mariozechner/pi-agent-core`, `@mariozechner/pi-ai`, `zod`.

  **Approach:**
  - `createAgent(workspaceId)` returns an `Agent` with `systemPrompt` from `buildSystemPrompt` (ported from `reference/src/pi_docx_editor/agent.ts:391-433`).
  - `createLocalTools(workspaceId)` returns `Tool[]` — each tool's `execute` POSTs to the matching `/api/tools/<name>` with `{ workspaceId, ...args }`. Shared zod schemas in `src/lib/tool-schemas.ts`.
  - `streamFn.ts` points to `/api/llm/anthropic` so the browser never sees the key. Server proxies SSE passthrough to `api.anthropic.com/v1/messages` with `ANTHROPIC_API_KEY` injected.
  - `useAgent` subscribes to all `AgentSessionEvent`s and maps them to React state per the table in `PLAN.md` §4. Exposes `{ messages, isStreaming, start, cancel }`.
  - `labels.ts` ports `formatToolExecutionLabel` (reference `agent.ts:168-192`). `renderers.ts` exposes `registerToolRenderer(name, Component)` + default component.
  - The client writes into activity log via server endpoints (no client-side fs writes).

  **Patterns to follow:**
  - `reference/pi-mono/packages/agent/` for `Agent` API.
  - `reference/pi-mono/packages/web-ui/` for subscribe/renderer idioms.
  - `reference/src/pi_docx_editor/agent.ts` for prompts/labels.

  **Test scenarios:**
  - Happy path: type a prompt → Claude streams text → `TextBlock` typewriters tokens → tool call appears as a pill → flips to "done" with detail → final message settles.
  - Happy path: `bash` tool call from the model → server executes → result feeds back into the loop.
  - Edge case: user cancels mid-stream → request aborted, UI re-enables composer.
  - Error path: proxy returns 401 → composer surfaces an error banner with a clear message (no key leak).
  - Integration: a `docx-tool replace-text` call fires the full loop: tool call → execution → checkpoint event → buffer reload (validated end-to-end in Unit 7 as well).

  **Verification:**
  - Prompt like "append a paragraph that says hello" causes the model to call `docx-tool append-paragraph`; pill turns green; SSE checkpoint arrives. Stream never leaks key to client; Network tab only shows `/api/*` calls.

- [ ] **Unit 7: Live-reload loop + workspace-event React plumbing**

  **Goal:** Tracked-change checkpoints flow from server → SSE → `editorRef.loadDocumentBuffer`, and user-side edits push back via debounced PUT.

  **Requirements:** R1, R5.

  **Dependencies:** Units 3, 4, 6.

  **Files:**
  - Create: `src/hooks/useWorkspaceEvents.ts`.
  - Modify: `src/components/docx/DocxPanel.tsx` — subscribe via `useWorkspaceEvents`, apply buffer on `checkpoint`.
  - Modify: `src/components/docx/useDocxSync.ts` — debounce `onChange` 500ms → PUT `/doc`; surface `turn-in-progress` error inline.
  - Modify: `src/server/checkpoint.ts` — emit `sourceTool` metadata so UI can show which tool caused a checkpoint.

  **Approach:**
  - `useWorkspaceEvents(workspaceId)` opens an `EventSource` on mount, parses events, exposes an imperative `onCheckpoint` callback.
  - `DocxPanel` tracks `lastAppliedSeq`; drops older checkpoints; on new checkpoint fetches `/doc?seq=N` as ArrayBuffer and calls `editorRef.current.loadDocumentBuffer(buf)`.
  - `useDocxSync` debounces `onChange`; skips while `isAgentTurn` is true; on a rejected PUT (`turn-in-progress`) surfaces a toast and re-attempts after the next `agent_end` event.

  **Patterns to follow:**
  - `EventSource` native API; no extra lib.

  **Test scenarios:**
  - Happy path: agent mutates → SSE `checkpoint` → redline appears live without full remount.
  - Edge case: two checkpoints in rapid succession → older one ignored.
  - Edge case: user edits DOCX while agent is running → change queued until `agent_end`.
  - Integration: full round-trip — agent edit → checkpoint → redline → user accepts → export produces updated DOCX.

  **Verification:**
  - Manual: "change the title to FOO" causes a single live redline with author="Agent"; user accepts, exports, opens in Word, text is FOO.

- [ ] **Unit 8: Polish, empty states, error surfaces, TweaksPanel behavior**

  **Goal:** Ship-ready: empty state, error banners, metrics footer, agent-authoring toggle, composer hints, documented dev commands.

  **Requirements:** R6 (polish), R7 (no key exposure verified).

  **Dependencies:** Units 2, 3, 6, 7.

  **Files:**
  - Modify: `src/components/chat/ComposerHints.tsx`, `TweaksPanel.tsx`, `ChatPanel.tsx`, `DocxPanel.tsx`.
  - Modify: `README.md` — dev setup, prereqs (`bun`, `uv`, `libreoffice`, Node 20+), `ANTHROPIC_API_KEY` env var.
  - Modify: `.env.example` — `ANTHROPIC_API_KEY=`.

  **Approach:**
  - Empty state on left pane before a workspace exists — drop zone + "Open DOCX".
  - Global error banner on LLM/tool failures with retry.
  - Metrics footer: tokens in/out, last tool, last checkpoint time. Pull from `agent.subscribe` `metrics`.
  - TweaksPanel toggles: pill density (compact / detailed) + agent authoring mode (`author` prop on SuperDoc).

  **Patterns to follow:**
  - Match tweak-panel CSS from `design/editor/project/editor-styles.css`.

  **Test scenarios:**
  - Happy path: empty left pane shows drop zone until a workspace exists.
  - Happy path: pill density toggle re-renders pills.
  - Error path: kill the Hono server mid-stream → UI shows a banner, composer re-enables.

  **Verification:**
  - Manual run-through per PLAN.md Phase 7 checklist: upload → chat → live redline → accept → export. Network tab shows no key leakage.

## System-Wide Impact

- **Interaction graph:** The Bun server is the single ingress for the browser (LLM proxy, tool endpoints, workspace I/O, SSE). The browser never talks to Anthropic or the filesystem directly.
- **Error propagation:** Structured `{ ok, error }` JSON from every tool endpoint. LLM proxy errors surface as chat banners. Checkpoint failures log to activity and toast.
- **State lifecycle risks:** Concurrent user edits during an agent turn are rejected (last-writer-wins is explicit). In-memory workspace session is lost on server restart — workspaces on disk remain intact and can be re-opened.
- **API surface parity:** Tool vocabulary intentionally matches `pi-coding-agent` so future moves to the real CLI agent (or a sandbox runner) don't change the browser code.
- **Integration coverage:** The agent → tool → checkpoint → buffer-reload round-trip is the integration path that unit tests alone won't prove. Unit 7's manual test is the load-bearing verification.
- **Unchanged invariants:** SuperDoc handles accept/reject/export natively; we do not reimplement tracked-change semantics.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| SuperDoc `loadDocumentBuffer` loses selection/scroll on checkpoint | Document the best-effort behavior in README; hold checkpoints during user edits; debounce aggressively. |
| `headless-word` / LibreOffice setup is fragile on the dev machine | README prereqs + a preflight script that shells out to `headless-word --version` and surfaces actionable errors on server boot. |
| Anthropic streaming SSE passthrough edge cases (backpressure, mid-stream disconnect) | Use Hono's streaming response primitive; ensure we forward the `Transfer-Encoding: chunked` headers; test with a slow-network throttle. |
| File-watcher + debounced checkpoint race with direct trigger from `docx-tool` endpoint | Coalesce triggers via a single `scheduleCheckpoint(reason)` function in `checkpoint.ts`. |
| pi-agent-core API drift between package versions | Pin exact versions of `@mariozechner/pi-agent-core` and `@mariozechner/pi-ai` in `package.json`; note the versions in README. |

## Documentation / Operational Notes

- README should include: prereqs, first-run (`bun install` + install `headless-word` via `uv tool install`), env var setup, one-command dev, manual smoke test, export path.
- `.env.example` lists `ANTHROPIC_API_KEY`.
- Seeded workspace files (`README_AGENT.md`, `HEADLESS_WORD_SKILL.md`, `docx-tool` shim) come from the reference and are ported as-is.

## Sources & References

- **Origin document:** [PLAN.md](../../PLAN.md)
- Reference repo (local): `reference/src/pi_docx_editor/`
- Design repo (local): `design/editor/project/`
- `@eigenpal/docx-js-editor` (SuperDoc)
- `@mariozechner/pi-agent-core`, `@mariozechner/pi-ai`
