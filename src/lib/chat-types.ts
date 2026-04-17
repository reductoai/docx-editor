// Shared chat message / block types used by the chat UI (Message,
// Conversation, ChatPanel) and the real agent hook (useAgent). These live
// outside the components/ folder so there's no temptation to reintroduce a
// scripted driver — the agent is the canonical producer now.

import type { IconName } from "../components/icons/Icon";

export type MessageRole = "user" | "assistant";

export type ToolState = "working" | "done" | "error";

export interface TextBlock {
  id: string;
  type: "text";
  text: string;
  streaming: boolean;
}

export interface ToolBlock {
  id: string;
  type: "tool";
  state: ToolState;
  icon?: IconName;
  name?: string;
  label: string;
  detail?: string;
  body?: string;
}

export interface ActionBlock {
  id: string;
  type: "action";
  tone: "success" | "warning" | "error";
  label: string;
  detail?: string;
  from?: string;
  to?: string;
  section?: string;
}

export interface ThinkingBlock {
  id: string;
  type: "thinking";
}

export type DisplayBlock = TextBlock | ToolBlock | ActionBlock | ThinkingBlock;

export interface ChatMessage {
  id: string;
  role: MessageRole;
  blocks: DisplayBlock[];
}
