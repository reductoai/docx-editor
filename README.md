# docx-editor

Localhost DOCX editor paired with a streaming agent chat. Real WYSIWYG tracked changes (SuperDoc), real bash/fs/docx-tool access, Claude in the loop.

## Prereqs

- `bun` ≥ 1.3
- `node` ≥ 20
- `python3` with [`uv`](https://docs.astral.sh/uv/)
- `libreoffice` (needed by `headless-word` for DOCX normalization)
- Optional but recommended: `rg` (ripgrep), `fd`
- `headless-word`: `uv tool install headless-word`

## Setup

```bash
bun install
cp .env.example .env
# then edit .env and set ANTHROPIC_API_KEY
```

## Run

```bash
bun run dev
```

This starts two processes via `concurrently`:

- Hono API on `http://localhost:3000` (`bun --watch server.ts`)
- Vite client on `http://localhost:5173`

Open `http://localhost:5173` in your browser.

## Smoke test (manual)

1. Upload a `.docx` file (drop zone or "Choose file").
2. Ask the agent to edit the document in the chat panel (e.g. "strengthen §2").
3. Watch tracked changes appear live in the left pane as the agent authors.
4. Accept or reject changes via the SuperDoc toolbar.
5. Export the edited `.docx` from the title bar.

## Architecture sketch

- **DOCX panel (`src/components/docx/`)** — SuperDoc (`@eigenpal/docx-js-editor`) rendering the buffer with `mode: "suggesting"` so every edit is a tracked change; checkpoints from the agent are applied by swapping the buffer via `loadDocumentBuffer`.
- **Chat panel (`src/components/chat/`)** — `pi-agent-core` runs the agent loop in the browser, streaming tool pills and assistant text through `useAgent`.
- **Bun/Hono server (`server.ts`, `src/server/`)** — proxies LLM requests, exposes tool endpoints (bash, fs, docx-tool), serves workspace files, and streams workspace events over SSE.
- **Workspace layout (`workspaces/<date>_<uuid>/`)** — each session gets its own directory containing `original.docx`, `working.docx`, `notes.md`, `agent_notes.md`, `README_AGENT.md`, `HEADLESS_WORD_SKILL.md`, `activity/`, and `docx-tool/`.

## Scope caveats

- No auth — intended for localhost-only use.
- No persistence across restarts beyond the filesystem workspaces directory (in-memory session state is lost on server restart).
- Last-writer-wins on concurrent edits — the debounced PUT from the editor pauses during agent turns, but there is no OT/CRDT reconciliation.
- `headless-word` graceful-fallback: if `headless-word` or `libreoffice` is unavailable, the docx-tool endpoint surfaces the error to the agent and the agent is prompted to work around it. The app still boots and the other tools still function.

## Further reading

- [`PLAN.md`](./PLAN.md) — original design doc and unit-by-unit plan.
- [`docs/plans/2026-04-17-001-feat-docx-editor-agent-chat-plan.md`](./docs/plans/2026-04-17-001-feat-docx-editor-agent-chat-plan.md) — living plan document.
