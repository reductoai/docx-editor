// Single source of truth for the model choices the user can switch between
// in the chat composer. IDs match `@mariozechner/pi-coding-agent`'s
// ModelRegistry so the server can resolve them directly via
// `registry.find("anthropic", id)`.

export interface ModelOption {
  id: string;
  label: string;
  tagline: string;
}

export const MODEL_OPTIONS: ModelOption[] = [
  {
    id: "claude-opus-4-7",
    label: "Claude Opus 4.7",
    tagline: "most capable",
  },
  {
    id: "claude-sonnet-4-5",
    label: "Claude Sonnet 4.5",
    tagline: "faster, solid",
  },
];

export const DEFAULT_MODEL_ID = "claude-opus-4-7";

export function isValidModelId(id: unknown): id is string {
  return typeof id === "string" && MODEL_OPTIONS.some((m) => m.id === id);
}
