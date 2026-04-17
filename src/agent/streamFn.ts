// Stream function used by the browser agent. It POSTs an Anthropic
// Messages API payload to our local proxy (`/api/llm/anthropic`) and parses
// the SSE response into `AssistantMessageEvent`s that pi-agent-core can
// consume.
//
// We do not use pi-agent-core's `streamProxy`: that helper speaks a custom
// proxy protocol (`/api/stream`), not the Anthropic Messages SSE format. A
// thin wrapper is therefore the simplest correct option.

import {
  createAssistantMessageEventStream,
  parseStreamingJson,
} from "@mariozechner/pi-ai";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Message,
  Model,
  SimpleStreamOptions,
  StopReason,
  ThinkingContent,
  TextContent,
  ToolCall,
} from "@mariozechner/pi-ai";
import type { StreamFn } from "@mariozechner/pi-agent-core";

const PROXY_PATH = "/api/llm/anthropic";

// ---------------------------------------------------------------------------
// Message/tool conversion to Anthropic Messages API wire format.
// Mirrors the subset of pi-ai/src/providers/anthropic.ts that we need here.
// ---------------------------------------------------------------------------

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: unknown; is_error?: boolean }
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "redacted_thinking"; data: string };

interface AnthropicMessageParam {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

function convertUserContent(
  content: Message["content"],
  allowImages: boolean,
): AnthropicContentBlock[] | string | null {
  if (typeof content === "string") {
    return content.trim().length > 0 ? content : null;
  }
  const blocks: AnthropicContentBlock[] = [];
  for (const item of content) {
    if (item.type === "text") {
      if (item.text.trim().length === 0) continue;
      blocks.push({ type: "text", text: item.text });
    } else if (item.type === "image" && allowImages) {
      blocks.push({
        type: "image",
        source: { type: "base64", media_type: item.mimeType, data: item.data },
      });
    }
  }
  return blocks.length > 0 ? blocks : null;
}

function convertToolResultContent(
  content: Message extends infer M ? M : never,
): AnthropicContentBlock[] | string {
  // content is (TextContent|ImageContent)[]; we only care about text/image
  const msg = content as unknown as {
    content: Array<TextContent | { type: "image"; data: string; mimeType: string }>;
  };
  const hasImage = msg.content.some((b) => b.type === "image");
  if (!hasImage) {
    return msg.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("\n");
  }
  return msg.content.map((b) => {
    if (b.type === "text") return { type: "text", text: b.text };
    return {
      type: "image",
      source: { type: "base64", media_type: b.mimeType, data: b.data },
    } as AnthropicContentBlock;
  });
}

function convertMessages(
  messages: Message[],
  allowImages: boolean,
): AnthropicMessageParam[] {
  const out: AnthropicMessageParam[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg.role === "user") {
      const converted = convertUserContent(msg.content, allowImages);
      if (converted === null) continue;
      out.push({ role: "user", content: converted });
    } else if (msg.role === "assistant") {
      const blocks: AnthropicContentBlock[] = [];
      for (const block of msg.content) {
        if (block.type === "text") {
          if (block.text.trim().length === 0) continue;
          blocks.push({ type: "text", text: block.text });
        } else if (block.type === "thinking") {
          const thinking = block as ThinkingContent;
          if (thinking.redacted) {
            blocks.push({
              type: "redacted_thinking",
              data: thinking.thinkingSignature ?? "",
            });
            continue;
          }
          if (thinking.thinking.trim().length === 0) continue;
          if (!thinking.thinkingSignature || thinking.thinkingSignature.trim().length === 0) {
            blocks.push({ type: "text", text: thinking.thinking });
          } else {
            blocks.push({
              type: "thinking",
              thinking: thinking.thinking,
              signature: thinking.thinkingSignature,
            });
          }
        } else if (block.type === "toolCall") {
          blocks.push({
            type: "tool_use",
            id: block.id,
            name: block.name,
            input: block.arguments ?? {},
          });
        }
      }
      if (blocks.length > 0) {
        out.push({ role: "assistant", content: blocks });
      }
    } else if (msg.role === "toolResult") {
      // Collect consecutive tool results into a single user message.
      const toolResults: AnthropicContentBlock[] = [];
      toolResults.push({
        type: "tool_result",
        tool_use_id: msg.toolCallId,
        content: convertToolResultContent(msg as any),
        is_error: msg.isError,
      });
      let j = i + 1;
      while (j < messages.length && messages[j]!.role === "toolResult") {
        const next = messages[j] as Extract<Message, { role: "toolResult" }>;
        toolResults.push({
          type: "tool_result",
          tool_use_id: next.toolCallId,
          content: convertToolResultContent(next as any),
          is_error: next.isError,
        });
        j++;
      }
      i = j - 1;
      out.push({ role: "user", content: toolResults });
    }
  }
  return out;
}

function convertTools(tools: Context["tools"]): unknown[] {
  if (!tools) return [];
  return tools.map((tool) => {
    const schema = tool.parameters as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    return {
      name: tool.name,
      description: tool.description,
      input_schema: {
        type: "object",
        properties: schema.properties ?? {},
        required: schema.required ?? [],
      },
    };
  });
}

function mapThinkingLevelToEffort(
  level: SimpleStreamOptions["reasoning"],
): "low" | "medium" | "high" {
  switch (level) {
    case "minimal":
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
    case "xhigh":
      return "high";
    default:
      return "medium";
  }
}

function supportsAdaptiveThinking(modelId: string): boolean {
  return (
    modelId.includes("opus-4-6") ||
    modelId.includes("opus-4.6") ||
    modelId.includes("opus-4-7") ||
    modelId.includes("opus-4.7") ||
    modelId.includes("sonnet-4-6") ||
    modelId.includes("sonnet-4.6")
  );
}

function mapStopReason(reason: string | null | undefined): StopReason {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
    case "pause_turn":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "toolUse";
    case "refusal":
    case "sensitive":
      return "error";
    default:
      return "stop";
  }
}

function buildRequestBody(
  model: Model<any>,
  context: Context,
  options: SimpleStreamOptions | undefined,
) {
  const body: Record<string, unknown> = {
    model: model.id,
    max_tokens: options?.maxTokens ?? Math.min(model.maxTokens, 32000),
    messages: convertMessages(context.messages, model.input.includes("image")),
    stream: true,
  };

  if (context.systemPrompt) {
    body.system = [
      { type: "text", text: context.systemPrompt },
    ];
  }

  if (context.tools && context.tools.length > 0) {
    body.tools = convertTools(context.tools);
  }

  // Only set temperature when not thinking — Anthropic rejects the combo.
  const reasoning = options?.reasoning;
  if (model.reasoning && reasoning) {
    if (supportsAdaptiveThinking(model.id)) {
      body.thinking = { type: "adaptive", display: "summarized" };
      body.output_config = { effort: mapThinkingLevelToEffort(reasoning) };
    } else {
      const budgets = options?.thinkingBudgets ?? {};
      const budget =
        reasoning === "minimal"
          ? (budgets.minimal ?? 1024)
          : reasoning === "low"
            ? (budgets.low ?? 2048)
            : reasoning === "medium"
              ? (budgets.medium ?? 8192)
              : (budgets.high ?? 16384);
      body.thinking = {
        type: "enabled",
        budget_tokens: budget,
        display: "summarized",
      };
    }
  } else if (options?.temperature !== undefined) {
    body.temperature = options.temperature;
  }

  return body;
}

// ---------------------------------------------------------------------------
// Anthropic SSE -> AssistantMessageEvent translation.
// ---------------------------------------------------------------------------

interface SSEEvent {
  event?: string;
  data: string;
}

function parseSSEBuffer(buffer: string): { events: SSEEvent[]; rest: string } {
  const events: SSEEvent[] = [];
  let rest = buffer;
  while (true) {
    const splitIdx = rest.indexOf("\n\n");
    if (splitIdx === -1) break;
    const chunk = rest.slice(0, splitIdx);
    rest = rest.slice(splitIdx + 2);
    let eventName: string | undefined;
    const dataLines: string[] = [];
    for (const line of chunk.split("\n")) {
      if (line.startsWith("event:")) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trim());
      }
    }
    if (dataLines.length > 0) {
      events.push({ event: eventName, data: dataLines.join("\n") });
    }
  }
  return { events, rest };
}

function streamAnthropicViaProxy(
  model: Model<any>,
  context: Context,
  options: SimpleStreamOptions | undefined,
): ReturnType<StreamFn> {
  const stream = createAssistantMessageEventStream();
  (async () => {
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };

    const blocks = output.content as (TextContent | ThinkingContent | ToolCall)[];
    // Map from Anthropic block index (from content_block_start.index) to
    // our local contentIndex in output.content[].
    const indexMap = new Map<number, number>();

    const body = buildRequestBody(model, context, options);
    const signal = options?.signal;

    const pushEvent = (event: AssistantMessageEvent) => stream.push(event);

    try {
      const response = await fetch(PROXY_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });

      if (!response.ok || !response.body) {
        let message = `${response.status} ${response.statusText}`;
        try {
          const errJson = (await response.json()) as { error?: string };
          if (errJson.error) message = errJson.error;
        } catch {
          // ignore
        }
        throw new Error(message);
      }

      pushEvent({ type: "start", partial: output });

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (signal?.aborted) throw new Error("Request aborted by user");
        buffer += decoder.decode(value, { stream: true });
        const { events, rest } = parseSSEBuffer(buffer);
        buffer = rest;
        for (const ev of events) {
          if (!ev.data || ev.data === "[DONE]") continue;
          let payload: any;
          try {
            payload = JSON.parse(ev.data);
          } catch {
            continue;
          }
          const type = (payload.type as string) ?? ev.event;
          if (type === "message_start") {
            const usage = payload.message?.usage ?? {};
            output.responseId = payload.message?.id;
            output.usage.input = usage.input_tokens ?? 0;
            output.usage.output = usage.output_tokens ?? 0;
            output.usage.cacheRead = usage.cache_read_input_tokens ?? 0;
            output.usage.cacheWrite = usage.cache_creation_input_tokens ?? 0;
            output.usage.totalTokens =
              output.usage.input +
              output.usage.output +
              output.usage.cacheRead +
              output.usage.cacheWrite;
          } else if (type === "content_block_start") {
            const idx = payload.index as number;
            const cb = payload.content_block;
            if (cb?.type === "text") {
              blocks.push({ type: "text", text: "" });
              const ci = blocks.length - 1;
              indexMap.set(idx, ci);
              pushEvent({ type: "text_start", contentIndex: ci, partial: output });
            } else if (cb?.type === "thinking") {
              blocks.push({ type: "thinking", thinking: "", thinkingSignature: "" });
              const ci = blocks.length - 1;
              indexMap.set(idx, ci);
              pushEvent({ type: "thinking_start", contentIndex: ci, partial: output });
            } else if (cb?.type === "redacted_thinking") {
              blocks.push({
                type: "thinking",
                thinking: "[Reasoning redacted]",
                thinkingSignature: cb.data ?? "",
                redacted: true,
              });
              const ci = blocks.length - 1;
              indexMap.set(idx, ci);
              pushEvent({ type: "thinking_start", contentIndex: ci, partial: output });
            } else if (cb?.type === "tool_use") {
              const tc: ToolCall & { partialJson?: string } = {
                type: "toolCall",
                id: cb.id,
                name: cb.name,
                arguments: cb.input ?? {},
                partialJson: "",
              };
              blocks.push(tc);
              const ci = blocks.length - 1;
              indexMap.set(idx, ci);
              pushEvent({
                type: "toolcall_start",
                contentIndex: ci,
                partial: output,
              });
            }
          } else if (type === "content_block_delta") {
            const idx = payload.index as number;
            const ci = indexMap.get(idx);
            if (ci === undefined) continue;
            const block = blocks[ci];
            const delta = payload.delta;
            if (!block || !delta) continue;
            if (delta.type === "text_delta" && block.type === "text") {
              block.text += delta.text ?? "";
              pushEvent({
                type: "text_delta",
                contentIndex: ci,
                delta: delta.text ?? "",
                partial: output,
              });
            } else if (delta.type === "thinking_delta" && block.type === "thinking") {
              block.thinking += delta.thinking ?? "";
              pushEvent({
                type: "thinking_delta",
                contentIndex: ci,
                delta: delta.thinking ?? "",
                partial: output,
              });
            } else if (delta.type === "signature_delta" && block.type === "thinking") {
              block.thinkingSignature = (block.thinkingSignature ?? "") + (delta.signature ?? "");
            } else if (delta.type === "input_json_delta" && block.type === "toolCall") {
              const tc = block as ToolCall & { partialJson?: string };
              tc.partialJson = (tc.partialJson ?? "") + (delta.partial_json ?? "");
              tc.arguments = parseStreamingJson(tc.partialJson) || {};
              pushEvent({
                type: "toolcall_delta",
                contentIndex: ci,
                delta: delta.partial_json ?? "",
                partial: output,
              });
            }
          } else if (type === "content_block_stop") {
            const idx = payload.index as number;
            const ci = indexMap.get(idx);
            if (ci === undefined) continue;
            const block = blocks[ci];
            if (!block) continue;
            if (block.type === "text") {
              pushEvent({
                type: "text_end",
                contentIndex: ci,
                content: block.text,
                partial: output,
              });
            } else if (block.type === "thinking") {
              pushEvent({
                type: "thinking_end",
                contentIndex: ci,
                content: block.thinking,
                partial: output,
              });
            } else if (block.type === "toolCall") {
              const tc = block as ToolCall & { partialJson?: string };
              tc.arguments = parseStreamingJson(tc.partialJson) || tc.arguments;
              delete tc.partialJson;
              pushEvent({
                type: "toolcall_end",
                contentIndex: ci,
                toolCall: block as ToolCall,
                partial: output,
              });
            }
          } else if (type === "message_delta") {
            const stop = payload.delta?.stop_reason;
            if (stop) output.stopReason = mapStopReason(stop);
            const usage = payload.usage;
            if (usage) {
              if (usage.input_tokens != null) output.usage.input = usage.input_tokens;
              if (usage.output_tokens != null) output.usage.output = usage.output_tokens;
              if (usage.cache_read_input_tokens != null)
                output.usage.cacheRead = usage.cache_read_input_tokens;
              if (usage.cache_creation_input_tokens != null)
                output.usage.cacheWrite = usage.cache_creation_input_tokens;
              output.usage.totalTokens =
                output.usage.input +
                output.usage.output +
                output.usage.cacheRead +
                output.usage.cacheWrite;
            }
          } else if (type === "message_stop") {
            // no-op — final stopReason already set by message_delta
          } else if (type === "error") {
            const msg = payload.error?.message ?? "proxy returned error";
            throw new Error(msg);
          }
        }
      }

      if (signal?.aborted) throw new Error("Request aborted by user");

      const doneReason: Extract<StopReason, "stop" | "length" | "toolUse"> =
        output.stopReason === "length"
          ? "length"
          : output.stopReason === "toolUse"
            ? "toolUse"
            : "stop";
      output.stopReason = doneReason;
      pushEvent({ type: "done", reason: doneReason, message: output });
      stream.end();
    } catch (error) {
      // Strip scratch fields so replay is clean.
      for (const block of blocks as Array<any>) {
        delete block.partialJson;
        delete block.index;
      }
      const reason: Extract<StopReason, "error" | "aborted"> = signal?.aborted
        ? "aborted"
        : "error";
      output.stopReason = reason;
      output.errorMessage = error instanceof Error ? error.message : String(error);
      pushEvent({ type: "error", reason, error: output });
      stream.end();
    }
  })();

  return stream;
}

export function createProxyStreamFn(): StreamFn {
  return (model, context, options) =>
    streamAnthropicViaProxy(model, context, options);
}
