// Factory + lifecycle helpers for the browser-side Agent.

import { Agent, type AgentMessage } from "@mariozechner/pi-agent-core";
import { getModel, type Message } from "@mariozechner/pi-ai";
import { buildSystemPrompt } from "./prompts";
import { createLocalTools } from "./tools";
import { createProxyStreamFn } from "./streamFn";

// pi-agent-core exposes a `defaultConvertToLlm` internally but does not export
// it. We replicate the same semantics here: keep only the LLM-visible roles
// (user / assistant / toolResult). Since we don't use custom AgentMessage
// types, this is effectively a pass-through filter.
function convertToLlm(messages: AgentMessage[]): Message[] {
  return messages.filter(
    (m): m is Message =>
      m.role === "user" || m.role === "assistant" || m.role === "toolResult",
  );
}

export function createAgent(workspaceId: string): Agent {
  // `claude-sonnet-4-5` is the model ID we target. `getModel` is typed against
  // the generated registry in @mariozechner/pi-ai/dist/models.generated.js;
  // we verified at build time that the registry includes this id.
  const model = getModel("anthropic", "claude-sonnet-4-5");

  return new Agent({
    initialState: {
      systemPrompt: buildSystemPrompt(),
      model,
      thinkingLevel: "medium",
      tools: createLocalTools(workspaceId),
      messages: [],
    },
    convertToLlm,
    streamFn: createProxyStreamFn(),
  });
}

export function cancelAgent(agent: Agent): void {
  agent.abort();
}
