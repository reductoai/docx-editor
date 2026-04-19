// React hook that drives the chat UI by POSTing turns to the server-side
// agent at /api/chat/turn and consuming the SSE event stream back.
//
// The agent loop lives on the server (pi-coding-agent with createCodingTools)
// — this hook is purely a transport + reducer.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatToolExecutionLabel } from "../agent/labels";
import type {
  AttachmentBlock,
  ChatMessage,
  DisplayBlock,
  TextBlock,
  ToolBlock,
} from "../lib/chat-types";

// Shape of the AgentEvent union pi-agent-core emits. We only depend on the
// discriminated `type` + the fields each variant carries, so we type them
// locally rather than dragging pi-agent-core into the client bundle.
type AgentEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages: unknown[] }
  | { type: "turn_start" }
  | { type: "turn_end"; message: unknown; toolResults: unknown[] }
  | { type: "message_start"; message: { role: "user" | "assistant" } }
  | { type: "message_update"; message: unknown; assistantMessageEvent: AssistantSubEvent }
  | { type: "message_end"; message: { usage?: { input?: number; output?: number } } }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; args: unknown; partialResult: unknown }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: unknown; isError: boolean };

type AssistantSubEvent =
  | { type: "text_delta"; delta: string }
  | {
      type: "toolcall_start" | "toolcall_delta" | "toolcall_end";
      partial: { content: Array<{ type: string; id?: string; name?: string; arguments?: unknown }> };
      contentIndex: number;
    };

export interface SendAttachment {
  name: string;
  path: string;
}

export interface SendMessageOptions {
  /** Anthropic model id (e.g. `claude-sonnet-4-5`). Server falls back to its
   *  own default if omitted or invalid. */
  model?: string;
  attachments?: SendAttachment[];
  /** Text shown in the chat UI. Defaults to the full text if omitted. */
  displayText?: string;
}

export interface AgentChatState {
  messages: ChatMessage[];
  isStreaming: boolean;
  errorMessage: string | null;
  tokensIn: number;
  tokensOut: number;
  lastToolName: string | null;
  sendMessage: (text: string, options?: SendMessageOptions) => Promise<void>;
  cancel: () => void;
  dismissError: () => void;
  /** Download a debug bundle (JSON) of the current session's trace. */
  exportTrace: () => Promise<void>;
}

const NOOP_STATE: AgentChatState = {
  messages: [],
  isStreaming: false,
  errorMessage: null,
  tokensIn: 0,
  tokensOut: 0,
  lastToolName: null,
  sendMessage: async (_text: string, _options?: SendMessageOptions) => undefined,
  cancel: () => undefined,
  dismissError: () => undefined,
  exportTrace: async () => undefined,
};

function uid(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

// --- Reducer-style helpers (pure so they remain easy to reason about) -------

function appendUserMessage(
  messages: ChatMessage[],
  text: string,
  attachments?: SendAttachment[],
): ChatMessage[] {
  const blocks: DisplayBlock[] = [];
  if (text) {
    blocks.push({
      id: uid("text"),
      type: "text",
      text,
      streaming: false,
    } satisfies TextBlock);
  }
  if (attachments?.length) {
    for (const att of attachments) {
      blocks.push({
        id: uid("att"),
        type: "attachment",
        name: att.name,
        path: att.path,
      } satisfies AttachmentBlock);
    }
  }
  return [
    ...messages,
    { id: uid("user"), role: "user", blocks },
  ];
}

function ensureAssistant(
  messages: ChatMessage[],
  assistantId: string,
): ChatMessage[] {
  if (messages.some((m) => m.id === assistantId)) return messages;
  return [
    ...messages,
    { id: assistantId, role: "assistant", blocks: [] },
  ];
}

function mapAssistantBlocks(
  messages: ChatMessage[],
  assistantId: string,
  mapper: (blocks: DisplayBlock[]) => DisplayBlock[],
): ChatMessage[] {
  return messages.map((msg) =>
    msg.id === assistantId ? { ...msg, blocks: mapper(msg.blocks) } : msg,
  );
}

function appendTextDelta(blocks: DisplayBlock[], delta: string): DisplayBlock[] {
  const last = blocks[blocks.length - 1];
  if (last && last.type === "text" && last.streaming) {
    const updated: TextBlock = { ...last, text: last.text + delta };
    return [...blocks.slice(0, -1), updated];
  }
  const fresh: TextBlock = {
    id: uid("text"),
    type: "text",
    text: delta,
    streaming: true,
  };
  return [...blocks, fresh];
}

function finishStreamingText(blocks: DisplayBlock[]): DisplayBlock[] {
  return blocks.map((b) =>
    b.type === "text" && b.streaming ? { ...b, streaming: false } : b,
  );
}

function upsertToolBlock(
  blocks: DisplayBlock[],
  toolCallId: string,
  init: Omit<ToolBlock, "id" | "type">,
): DisplayBlock[] {
  const existingIdx = blocks.findIndex(
    (b) => b.type === "tool" && getToolCallId(b) === toolCallId,
  );
  if (existingIdx >= 0) {
    const existing = blocks[existingIdx] as ToolBlock;
    const merged: ToolBlock = { ...existing, ...init };
    const next = [...blocks];
    next[existingIdx] = merged;
    return next;
  }
  const fresh: ToolBlock = {
    id: makeToolBlockId(toolCallId),
    type: "tool",
    ...init,
  };
  return [...blocks, fresh];
}

function updateToolBlock(
  blocks: DisplayBlock[],
  toolCallId: string,
  patch: Partial<Omit<ToolBlock, "id" | "type">>,
): DisplayBlock[] {
  return blocks.map((b) => {
    if (b.type !== "tool") return b;
    if (getToolCallId(b) !== toolCallId) return b;
    return { ...b, ...patch } as ToolBlock;
  });
}

function makeToolBlockId(toolCallId: string) {
  return `tool-${toolCallId}`;
}

function getToolCallId(block: ToolBlock): string {
  return block.id.startsWith("tool-") ? block.id.slice(5) : block.id;
}

// ---------------------------------------------------------------------------
// SSE frame parser: consumes `ReadableStream<Uint8Array>` and yields parsed
// `{ event, data }` frames. Ignores `: comment` lines used for heartbeats.
// ---------------------------------------------------------------------------
async function* iterateSseFrames(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<{ event: string; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      if (signal.aborted) return;
      const { value, done } = await reader.read();
      if (done) return;
      buf += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buf.indexOf("\n\n")) !== -1) {
        const block = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        if (!block.trim()) continue;
        let ev = "message";
        let data = "";
        for (const line of block.split("\n")) {
          if (line.startsWith(":")) continue;
          if (line.startsWith("event:")) ev = line.slice(6).trim();
          else if (line.startsWith("data:"))
            data += (data ? "\n" : "") + line.slice(5).trim();
        }
        yield { event: ev, data };
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ---------------------------------------------------------------------------

export function useAgent(workspaceId: string | null): AgentChatState {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [tokensIn, setTokensIn] = useState(0);
  const [tokensOut, setTokensOut] = useState(0);
  const [lastToolName, setLastToolName] = useState<string | null>(null);
  const currentAssistantIdRef = useRef<string | null>(null);
  const inFlightRef = useRef<AbortController | null>(null);
  // Ring-buffered raw event log for debug trace exports.
  const eventLogRef = useRef<Array<{ ts: string; event: unknown }>>([]);
  const MAX_EVENT_LOG = 2000;

  // Reset when the workspace changes (or clears).
  useEffect(() => {
    // Abort any in-flight turn — the new workspace has its own transcript.
    if (inFlightRef.current) {
      try { inFlightRef.current.abort(); } catch { /* ignore */ }
      inFlightRef.current = null;
    }
    currentAssistantIdRef.current = null;
    eventLogRef.current = [];
    setMessages([]);
    setIsStreaming(false);
    setErrorMessage(null);
    setTokensIn(0);
    setTokensOut(0);
    setLastToolName(null);
  }, [workspaceId]);

  const dismissError = useCallback(() => setErrorMessage(null), []);

  const sendMessage = useCallback(
    async (text: string, options?: SendMessageOptions) => {
      const trimmed = text.trim();
      if (!trimmed || !workspaceId) return;
      if (inFlightRef.current) return; // ignore while a turn is running

      const shown = options?.displayText ?? trimmed;
      setMessages((prev) => appendUserMessage(prev, shown, options?.attachments));
      setErrorMessage(null);

      const controller = new AbortController();
      inFlightRef.current = controller;

      const handlers: Handlers = {
        setMessages,
        setIsStreaming,
        setErrorMessage,
        setTokensIn,
        setTokensOut,
        setLastToolName,
        currentAssistantIdRef,
      };

      try {
        setIsStreaming(true);
        const res = await fetch("/api/chat/turn", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
          },
          body: JSON.stringify({
            workspaceId,
            userText: trimmed,
            ...(options?.model ? { model: options.model } : {}),
          }),
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          let detail = `HTTP ${res.status}`;
          try {
            const payload = (await res.json()) as { error?: string };
            if (payload?.error) detail = payload.error;
          } catch { /* ignore */ }
          setErrorMessage(detail);
          return;
        }

        for await (const frame of iterateSseFrames(res.body, controller.signal)) {
          if (!frame.data) continue;
          let payload: unknown;
          try {
            payload = JSON.parse(frame.data);
          } catch {
            continue;
          }
          const log = eventLogRef.current;
          log.push({ ts: new Date().toISOString(), event: payload });
          if (log.length > MAX_EVENT_LOG) log.splice(0, log.length - MAX_EVENT_LOG);

          if (frame.event === "error") {
            const msg = (payload as { message?: string })?.message;
            if (msg && !isAbortString(msg)) setErrorMessage(msg);
            continue;
          }
          if (frame.event === "done") continue;
          // Everything else is an AgentSessionEvent.
          handleEvent(payload as AgentEvent, handlers);
        }
      } catch (err) {
        if (!isAbortError(err)) {
          const msg = err instanceof Error ? err.message : String(err);
          if (!isAbortString(msg)) setErrorMessage(msg);
        }
      } finally {
        if (inFlightRef.current === controller) inFlightRef.current = null;
        setIsStreaming(false);
        currentAssistantIdRef.current = null;
      }
    },
    [workspaceId],
  );

  const cancel = useCallback(() => {
    const controller = inFlightRef.current;
    if (!controller || !workspaceId) return;
    // Abort our SSE read — the server's `cancel()` hook will fire via the
    // aborted connection. Also POST /api/chat/cancel as a belt+suspenders in
    // case the server's stream cancel doesn't propagate quickly.
    try { controller.abort(); } catch { /* ignore */ }
    void fetch("/api/chat/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId }),
    }).catch(() => undefined);
  }, [workspaceId]);

  const exportTrace = useCallback(async () => {
    if (!workspaceId) return;
    let serverActivity: unknown = null;
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/activity`);
      if (res.ok) serverActivity = await res.json();
      else serverActivity = { error: `HTTP ${res.status}` };
    } catch (err) {
      serverActivity = { error: (err as Error).message };
    }

    const bundle = {
      exportedAt: new Date().toISOString(),
      workspaceId,
      userAgent: navigator.userAgent,
      url: window.location.href,
      chat: {
        messages,
        isStreaming,
        errorMessage,
        tokensIn,
        tokensOut,
        lastToolName,
      },
      events: eventLogRef.current,
      serverActivity,
    };

    const blob = new Blob([JSON.stringify(bundle, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const stamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .slice(0, 19);
    a.download = `reducto-trace_${workspaceId}_${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, [
    workspaceId,
    messages,
    isStreaming,
    errorMessage,
    tokensIn,
    tokensOut,
    lastToolName,
  ]);

  const state = useMemo<AgentChatState>(
    () => ({
      messages,
      isStreaming,
      errorMessage,
      tokensIn,
      tokensOut,
      lastToolName,
      sendMessage,
      cancel,
      dismissError,
      exportTrace,
    }),
    [
      messages,
      isStreaming,
      errorMessage,
      tokensIn,
      tokensOut,
      lastToolName,
      sendMessage,
      cancel,
      dismissError,
      exportTrace,
    ],
  );

  return workspaceId ? state : NOOP_STATE;
}

// ---------------------------------------------------------------------------
// Event handler. Keeps all state mutation in one place so the subscriber is
// easy to reason about.
// ---------------------------------------------------------------------------

interface Handlers {
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  setIsStreaming: React.Dispatch<React.SetStateAction<boolean>>;
  setErrorMessage: React.Dispatch<React.SetStateAction<string | null>>;
  setTokensIn: React.Dispatch<React.SetStateAction<number>>;
  setTokensOut: React.Dispatch<React.SetStateAction<number>>;
  setLastToolName: React.Dispatch<React.SetStateAction<string | null>>;
  currentAssistantIdRef: React.MutableRefObject<string | null>;
}

function handleEvent(event: AgentEvent, h: Handlers) {
  const {
    setMessages,
    setIsStreaming,
    setErrorMessage,
    setTokensIn,
    setTokensOut,
    setLastToolName,
    currentAssistantIdRef,
  } = h;

  switch (event.type) {
    case "agent_start": {
      setIsStreaming(true);
      setErrorMessage(null);
      break;
    }
    case "message_start": {
      if (event.message.role === "assistant") {
        const assistantId = uid("assistant");
        currentAssistantIdRef.current = assistantId;
        setMessages((prev) => ensureAssistant(prev, assistantId));
      }
      break;
    }
    case "message_update": {
      const assistantId = currentAssistantIdRef.current;
      if (!assistantId) break;
      const sub = event.assistantMessageEvent;
      if (sub.type === "text_delta") {
        setMessages((prev) =>
          mapAssistantBlocks(prev, assistantId, (blocks) =>
            appendTextDelta(blocks, sub.delta),
          ),
        );
      } else if (sub.type === "toolcall_start") {
        const block = sub.partial.content[sub.contentIndex];
        if (block && block.type === "toolCall" && block.id) {
          const name = block.name ?? "tool";
          setMessages((prev) =>
            mapAssistantBlocks(prev, assistantId, (blocks) =>
              upsertToolBlock(finishStreamingText(blocks), block.id!, {
                state: "working",
                name,
                label: formatToolExecutionLabel(name, block.arguments),
              }),
            ),
          );
        }
      } else if (sub.type === "toolcall_delta" || sub.type === "toolcall_end") {
        const block = sub.partial.content[sub.contentIndex];
        if (block && block.type === "toolCall" && block.id) {
          const name = block.name ?? "tool";
          setMessages((prev) =>
            mapAssistantBlocks(prev, assistantId, (blocks) =>
              updateToolBlock(blocks, block.id!, {
                label: formatToolExecutionLabel(name, block.arguments),
              }),
            ),
          );
        }
      }
      break;
    }
    case "message_end": {
      const assistantId = currentAssistantIdRef.current;
      if (!assistantId) break;
      setMessages((prev) =>
        mapAssistantBlocks(prev, assistantId, finishStreamingText),
      );
      const usage = event.message?.usage;
      if (usage) {
        if (typeof usage.input === "number") setTokensIn((n) => n + usage.input!);
        if (typeof usage.output === "number") setTokensOut((n) => n + usage.output!);
      }
      break;
    }
    case "tool_execution_start": {
      const assistantId = currentAssistantIdRef.current;
      if (!assistantId) break;
      setLastToolName(event.toolName);
      setMessages((prev) =>
        mapAssistantBlocks(prev, assistantId, (blocks) =>
          upsertToolBlock(blocks, event.toolCallId, {
            state: "working",
            name: event.toolName,
            label: formatToolExecutionLabel(event.toolName, event.args),
            args: event.args,
          }),
        ),
      );
      break;
    }
    case "tool_execution_end": {
      const assistantId = currentAssistantIdRef.current;
      if (!assistantId) break;
      const errorText = extractErrorText(event.result);
      setMessages((prev) =>
        mapAssistantBlocks(prev, assistantId, (blocks) =>
          updateToolBlock(blocks, event.toolCallId, {
            state: event.isError ? "error" : "done",
            detail: errorText,
            result: event.result,
            isError: event.isError,
          }),
        ),
      );
      // Don't surface tool-call errors as a top-level toast — they're
      // expected (ambiguous matches, missing paths, etc.) and already
      // rendered on the tool block itself. The agent recovers on its own.
      break;
    }
    case "agent_end": {
      setIsStreaming(false);
      currentAssistantIdRef.current = null;
      break;
    }
    default:
      break;
  }
}

function isAbortError(err: unknown): boolean {
  if (!err) return false;
  const anyErr = err as { name?: string; message?: string };
  if (anyErr.name === "AbortError") return true;
  return isAbortString(anyErr.message ?? "");
}

function isAbortString(msg: string): boolean {
  return /aborted without reason|operation was aborted|The user aborted|signal is aborted/i.test(
    msg,
  );
}

function extractErrorText(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const anyResult = result as {
    content?: Array<{ type?: string; text?: string }>;
  };
  const first = anyResult.content?.find((c) => c?.type === "text");
  return first?.text;
}
