// Shared types used across server + client.

export type WorkspaceEventKind = "checkpoint" | "status" | "error";

export type WorkspaceEvent =
  | {
      kind: "checkpoint";
      seq: number;
      docxUrl: string;
      sourceTool?: string;
    }
  | { kind: "status"; message: string }
  | { kind: "error"; message: string };

export interface CheckpointPayload {
  seq: number;
  docxUrl: string;
  sourceTool?: string;
}

export interface ActivityEvent {
  ts: string;
  type: string;
  [key: string]: unknown;
}

export interface ToolEndpointResult<T = unknown> {
  ok: boolean;
  error?: string;
  data?: T;
}
