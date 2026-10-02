import type { WebSocket } from "ws";
import type { Access, AudioClip, Device, Origin, ToolCallRow, ToolSpec } from "./types";

export type ToolResult = { ok: boolean; output?: string; error?: string; denied?: boolean; decided_by?: string };

export type PendingCall = {
  row: ToolCallRow;
  resolve: (result: ToolResult) => void;
  // Called when the device reports it is waiting for a human, to stretch the timeout.
  awaitingApproval: () => void;
};

// An audio clip arriving from a device: JSON header, binary chunks, JSON footer.
export type Upload = {
  clipId: string;
  sampleRate: number;
  channels: number;
  source: "mic" | "web" | "agent" | "note";
  note?: string;
  prompt?: boolean; // the device is asking for this clip to be transcribed and answered
  chunks: Buffer[];
  bytes: number;
  startedAt: number;
};

// Everything the server knows about a connected device.
export type DeviceLink = {
  ws: WebSocket;
  capabilities?: string[];
  video?: import("./video/stream").VideoStream;
  // A voice note being played back on the device's own speaker.
  note?: import("./notes/player").NotePlayer;
  device: Device;
  protocol: number;
  tools: ToolSpec[];
  access: Access | null;
  // The networks the device has saved and which one it is on. Names only — the
  // passwords stay on the device and are never reported upward. Held here rather
  // than in the database because it is live state, true only while connected.
  wifi?: { ssids: string[]; current: string };
  // The server owns which session is live; both the device and the web UI add to it.
  activeSessionId: string | null;
  // toolSinceText: a tool ran since the last text chunk, so the stored reply needs a paragraph break.
  run?: { abort: AbortController; sessionId: string | null; origin: Origin; toolSinceText?: boolean };
  pending: Map<string, PendingCall>;
  upload?: Upload;
  // Someone (the web UI, or a tool) is waiting for the clip this device is recording.
  clipWaiters: Map<string, (clip: AudioClip | null, error?: string) => void>;
};

// The gateway (loaded by server.ts) and Next route handlers are separate module
// graphs in the same process, so shared state hangs off globalThis.
const g = globalThis as { __aitermLinks?: Map<string, DeviceLink> };
const links = (g.__aitermLinks ??= new Map<string, DeviceLink>());

export const live = {
  link: (deviceId: string) => links.get(deviceId),
  get: (deviceId: string) => links.get(deviceId)?.ws,
  attach: (link: DeviceLink) => links.set(link.device.id, link),
  // Only removes the entry if it still belongs to this socket (it may have been replaced).
  release: (deviceId: string, ws: WebSocket) => {
    const link = links.get(deviceId);
    if (link?.ws !== ws) return undefined;
    links.delete(deviceId);
    return link;
  },
  isOnline: (deviceId: string) => links.has(deviceId),
  count: () => links.size,
  send: (deviceId: string, msg: unknown) => {
    const ws = links.get(deviceId)?.ws;
    if (!ws || ws.readyState !== ws.OPEN) return false;
    ws.send(JSON.stringify(msg));
    return true;
  },
  kick: (deviceId: string, reason = "closed by admin") => {
    const ws = links.get(deviceId)?.ws;
    if (!ws) return false;
    ws.close(4001, reason);
    return true;
  },
};
