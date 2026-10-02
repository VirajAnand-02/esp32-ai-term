// "agent" is an attached harness (OpenClaw, NanoClaw, Hermes) rather than a machine
// that connects to us: the server calls out to its HTTP endpoint, so it never appears
// in the live registry and "online" is replaced by "reachable". See src/lib/peers.ts.
export const DEVICE_KINDS = ["esp32", "web", "cli", "other", "agent"] as const;
export type DeviceKind = (typeof DEVICE_KINDS)[number];

export const EVENT_TYPES = ["connect", "disconnect", "chat", "command", "action", "log", "error"] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const LEVELS = ["debug", "info", "warn", "error"] as const;
export type Level = (typeof LEVELS)[number];

export type Device = {
  id: string;
  name: string;
  kind: DeviceKind;
  hostname: string | null;
  firmware: string | null;
  hw: string | null;
  ip: string | null;
  status: "online" | "offline";
  last_seen_at: string | null;
  config: Record<string, unknown>;
  created_at: string;
};

export type EventRow = {
  id: number;
  device_id: string | null;
  type: EventType;
  level: Level;
  summary: string;
  payload: Record<string, unknown> | null;
  created_at: string;
  device?: { name: string; kind: DeviceKind } | null;
};

export type Message = {
  id: number;
  session_id: string;
  device_id: string;
  role: "system" | "user" | "assistant";
  content: string;
  tokens: number;
  origin?: Origin;
  created_at: string;
};

export type Origin = "device" | "web";

export const ACCESS_LEVELS = ["readonly", "standard", "trusted", "yolo"] as const;
export type AccessLevel = (typeof ACCESS_LEVELS)[number];
export type Access = { level: AccessLevel; remote_approval: boolean };

export type ToolSpec = { name: string; description: string; parameters: Record<string, unknown>; risk: string };

export type ToolCallStatus = "running" | "awaiting_approval" | "ok" | "error" | "denied";

export type ToolCallRow = {
  id: string;
  session_id: string;
  device_id: string;
  name: string;
  args: Record<string, unknown>;
  risk: string | null;
  status: ToolCallStatus;
  reason: string | null;
  output: string | null;
  decided_by: string | null;
  created_at: string;
  finished_at: string | null;
};

export type AudioClip = {
  id: string;
  device_id: string;
  session_id: string | null;
  path: string;
  seconds: number;
  sample_rate: number;
  channels: number;
  bytes: number;
  peak: number | null;
  source: "mic" | "web" | "agent" | "note";
  note: string | null;
  transcript?: string | null;
  transcript_model?: string | null;
  created_at: string;
};

// Everything that happens in a device's live session, fanned out to dashboards.
export type SessionFrame =
  | { type: "chat.user"; session_id: string; text: string; origin: Origin }
  | { type: "chat.delta"; session_id: string; text: string }
  | { type: "chat.done"; session_id: string; usage: { input: number; output: number }; aborted?: boolean }
  | { type: "tool"; call: ToolCallRow }
  | { type: "session"; session_id: string | null }
  | { type: "access"; access: Access | null; tools: number }
  | { type: "audio"; state: "recording" | "uploading"; clip_id: string; seconds?: number }
  | { type: "clip"; clip: AudioClip }
  | { type: "error"; msg: string };

export type Session = {
  id: string;
  device_id: string;
  title: string | null;
  model: string | null;
  started_at: string;
  ended_at: string | null;
  input_tokens: number;
  output_tokens: number;
  messages?: Message[];
};

export type Memory = {
  id: string;
  device_id: string | null;
  content: string;
  tags: string[];
  enabled: boolean;
  created_at: string;
};

export type LlmSettings = {
  model: string;
  temperature: number | null;
  maxOutputTokens: number;
  systemPrompt: string;
};

// How to reach an attached agent harness. Lives in its own table, not in
// devices.config, because the key has to be sent in plaintext and config is returned
// to the browser with every device read.
export type AgentPeer = {
  device_id: string;
  base_url: string;
  api_key: string | null;
  model: string | null;
  timeout_s: number;
};

// A private ICS url, so the agent can read a real calendar without an OAuth flow.
// Empty means the calendar tools are off.
export type CalendarSettings = {
  icsUrl: string;
};

// What the dashboard receives over SSE.
export type LiveMessage =
  | { kind: "event"; event: EventRow }
  | { kind: "presence"; deviceId: string; status: "online" | "offline"; ip?: string | null; at: string }
  | { kind: "session"; deviceId: string; frame: SessionFrame }
  // The device told us its settings changed. Sent so an open config tab shows the
  // hardware's truth rather than whatever it last pushed down.
  | { kind: "device"; deviceId: string; config: Record<string, unknown> };
