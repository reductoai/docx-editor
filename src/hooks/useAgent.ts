// React hook that bridges pi-agent-core events into the chat message shape
// consumed by `Conversation` / `Message`.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Agent, AgentEvent } from "@mariozechner/pi-agent-core";
import { createAgent } from "../agent/agent";
import { formatToolExecutionLabel } from "../agent/labels";
import type {
  ChatMessage,
  DisplayBlock,
  TextBlock,
  ToolBlock,
} from "../lib/chat-types";

export interface AgentChatState {
  messages: ChatMessage[];
  isStreaming: boolean;
  errorMessage: string | null;
  tokensIn: number;
  tokensOut: number;
  lastToolName: string | null;
  sendMessage: (text: string) => Promise<void>;
  cancel: () => void;
  dismissError: () => void;
}

const NOOP_STATE: AgentChatState = {
  messages: [],
  isStreaming: false,
  errorMessage: null,
  tokensIn: 0,
  tokensOut: 0,
  lastToolName: null,
  sendMessage: async () => undefined,
  cancel: () => undefined,
  dismissError: () => undefined,
};

function uid(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

// --- Reducer-style helpers (pure so they remain easy to reason about) -------

function appendUserMessage(messages: ChatMessage[], text: string): ChatMessage[] {
  return [
    ...messages,
    {
      id: uid("user"),
      role: "user",
      blocks: [
        {
          id: uid("text"),
          type: "text",
          text,
          streaming: false,
        },
      ],
    },
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
  // IDs are prefixed by `makeToolBlockId`; fall back to the raw id if someone
  // registered a block without our prefix.
  return block.id.startsWith("tool-") ? block.id.slice(5) : block.id;
}

// ---------------------------------------------------------------------------

export function useAgent(workspaceId: string | null): AgentChatState {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [tokensIn, setTokensIn] = useState(0);
  const [tokensOut, setTokensOut] = useState(0);
  const [lastToolName, setLastToolName] = useState<string | null>(null);
  const agentRef = useRef<Agent | null>(null);
  const currentAssistantIdRef = useRef<string | null>(null);

  const teardown = useCallback(() => {
    const agent = agentRef.current;
    if (agent) {
      try {
        agent.abort();
      } catch {
        // ignore
      }
    }
    agentRef.current = null;
    currentAssistantIdRef.current = null;
    setMessages([]);
    setIsStreaming(false);
    setErrorMessage(null);
    setTokensIn(0);
    setTokensOut(0);
    setLastToolName(null);
  }, []);

  const dismissError = useCallback(() => setErrorMessage(null), []);

  // Build / tear down the agent when workspaceId changes.
  useEffect(() => {
    if (!workspaceId) {
      teardown();
      return undefined;
    }

    const agent = createAgent(workspaceId);
    agentRef.current = agent;

    const unsubscribe = agent.subscribe((event: AgentEvent) => {
      handleEvent(event, {
        setMessages,
        setIsStreaming,
        setErrorMessage,
        setTokensIn,
        setTokensOut,
        setLastToolName,
        currentAssistantIdRef,
      });
    });

    return () => {
      unsubscribe();
      try {
        agent.abort();
      } catch {
        // ignore
      }
      if (agentRef.current === agent) {
        agentRef.current = null;
      }
    };
  }, [workspaceId, teardown]);

  const sendMessage = useCallback(async (text: string) => {
    const agent = agentRef.current;
    const trimmed = text.trim();
    if (!trimmed || !agent) return;

    // Append the user message to our local transcript immediately so the UI
    // shows it without waiting for the (user) `message_start` event.
    setMessages((prev) => appendUserMessage(prev, trimmed));
    setErrorMessage(null);

    try {
      await agent.prompt(trimmed);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setErrorMessage(message);
    }
  }, []);

  const cancel = useCallback(() => {
    const agent = agentRef.current;
    if (agent) agent.abort();
  }, []);

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
        // Read the freshly-created toolCall block from partial to grab id+name.
        const block = sub.partial.content[sub.contentIndex];
        if (block && block.type === "toolCall") {
          const name = block.name;
          setMessages((prev) =>
            mapAssistantBlocks(prev, assistantId, (blocks) =>
              // Mark any in-progress text as done so the stream cursor lifts.
              upsertToolBlock(finishStreamingText(blocks), block.id, {
                state: "working",
                name,
                label: formatToolExecutionLabel(name, block.arguments),
              }),
            ),
          );
        }
      } else if (sub.type === "toolcall_delta" || sub.type === "toolcall_end") {
        // Keep the label fresh as args stream in.
        const block = sub.partial.content[sub.contentIndex];
        if (block && block.type === "toolCall") {
          setMessages((prev) =>
            mapAssistantBlocks(prev, assistantId, (blocks) =>
              updateToolBlock(blocks, block.id, {
                label: formatToolExecutionLabel(block.name, block.arguments),
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
      // Accumulate usage counts from assistant messages.
      const usage = (event.message as { usage?: { input?: number; output?: number } })
        .usage;
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
          }),
        ),
      );
      if (event.isError && errorText) {
        setErrorMessage(errorText);
      }
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

function extractErrorText(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const anyResult = result as {
    content?: Array<{ type?: string; text?: string }>;
  };
  const first = anyResult.content?.find((c) => c?.type === "text");
  return first?.text;
}
