// Registry of per-tool React renderers. Keeping this in its own module lets
// future work (Unit 7+) swap in richer renderers (e.g. docx diff viewers)
// without touching the hook that drives chat state.

import type { ReactNode } from "react";
import { createElement } from "react";
import ToolPill from "../components/chat/ToolPill";

export type ToolPillState = "working" | "done" | "error";

export interface ToolRendererProps {
  name: string;
  label: string;
  args: unknown;
  state: ToolPillState;
  result?: unknown;
  detail?: ReactNode;
  body?: ReactNode;
}

export type ToolPillRenderer = (props: ToolRendererProps) => ReactNode;

const registry = new Map<string, ToolPillRenderer>();

const defaultRenderer: ToolPillRenderer = ({ label, state, detail, body }) =>
  createElement(ToolPill, { label, state, detail, body });

export function registerToolRenderer(
  name: string,
  renderer: ToolPillRenderer,
): void {
  registry.set(name, renderer);
}

export function getToolRenderer(name: string): ToolPillRenderer {
  return registry.get(name) ?? defaultRenderer;
}
