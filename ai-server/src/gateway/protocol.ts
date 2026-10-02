import { z } from "zod";
import { ACCESS_LEVELS } from "@/lib/types";

// Protocol v1: JSON text frames over /ws. See PROTOCOL.md. v0 clients (no tools) still work.

export const PROTOCOL_VERSION = 1;

const toolSpec = z.object({
  name: z.string().regex(/^[a-z_][a-z0-9_]{0,63}$/),
  description: z.string().max(1000),
  parameters: z.record(z.string(), z.unknown()),
  risk: z.string().max(32),
});

const access = z.object({ level: z.enum(ACCESS_LEVELS), remote_approval: z.boolean() });

export const inbound = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello"),
    protocol: z.number().int().optional(),
    fw: z.string().max(64).optional(),
    hw: z.string().max(64).optional(),
    capabilities: z.array(z.string().max(32)).max(32).optional(),
    tools: z.array(toolSpec).max(64).optional(),
    access: access.optional(),
  }),
  z.object({
    type: z.literal("log"),
    level: z.enum(["debug", "info", "warn", "error"]).default("info"),
    msg: z.string().max(2000),
  }),
  z.object({
    type: z.literal("event"),
    event: z.enum(["command", "action", "error"]),
    summary: z.string().max(500),
    payload: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    type: z.literal("chat"),
    session_id: z.uuid().optional(),
    text: z.string().min(1).max(8000),
  }),
  z.object({ type: z.literal("access"), level: z.enum(ACCESS_LEVELS), remote_approval: z.boolean() }),
  z.object({ type: z.literal("tool.pending"), call_id: z.string().max(128), reason: z.string().max(300) }),
  z.object({
    type: z.literal("tool.result"),
    call_id: z.string().max(128),
    ok: z.boolean(),
    output: z.string().max(64_000).optional(),
    error: z.string().max(4000).optional(),
    denied: z.boolean().optional(),
    decided_by: z.string().max(32).optional(),
  }),
  z.object({
    type: z.literal("audio.start"),
    clip_id: z.string().max(64),
    sample_rate: z.number().int().min(4000).max(48000).default(16000),
    channels: z.number().int().min(1).max(2).default(1),
    // "note" is a hands-free voice note: kept and listened to rather than answered.
    source: z.enum(["mic", "web", "agent", "note"]).default("mic"),
    note: z.string().max(200).optional(),
    // Push-to-talk: transcribe the clip and run it as a turn on this device.
    prompt: z.boolean().optional(),
  }),
  z.object({ type: z.literal("audio.end"), clip_id: z.string().max(64), aborted: z.boolean().optional() }),
  // Video playback. The device grants credit for as many frames and audio bytes as it
  // has room for; the server must not send beyond it.
  z.object({
    type: z.literal("video.ready"),
    id: z.string().max(64),
    video_credits: z.number().int().min(0).max(64),
    audio_credits: z.number().int().min(0).max(1 << 20),
  }),
  z.object({
    type: z.literal("video.ended"),
    id: z.string().max(64),
    shown: z.number().int().min(0).default(0),
    dropped: z.number().int().min(0).default(0),
    reason: z.string().max(64).optional(),
  }),
  // What the device's settings actually are, sent on connect and whenever one is
  // committed on the device. The dashboard can push the same keys back down, so the
  // two halves have to agree on the shape; the device clamps, and this is the truth.
  z.object({ type: z.literal("settings"), settings: z.record(z.string().max(64), z.union([z.number(), z.boolean()])) }),
  // The transport keys during playback. The server owns the position, because only
  // it can decode the source from somewhere else.
  z.object({
    type: z.literal("video.control"),
    id: z.string().max(64),
    action: z.enum(["pause", "resume", "seek_back", "seek_fwd"]),
  }),
  // Voice notes played back on the terminal's own speaker.
  // The saved network names and which one is joined. Passwords never come up: the
  // dashboard can add and forget, and does not need to read anything back.
  z.object({
    type: z.literal("wifi.networks"),
    ssids: z.array(z.string().max(32)).max(16),
    current: z.string().max(32),
  }),
  z.object({ type: z.literal("notes.list") }),
  z.object({ type: z.literal("note.play"), id: z.string().max(64), from_ms: z.number().int().min(0).default(0) }),
  z.object({ type: z.literal("note.stop") }),
  // "you may send this many more bytes"; a grant, not a level, so it cannot race
  // with whatever is already in flight.
  z.object({ type: z.literal("note.ready"), bytes: z.number().int().min(0).max(1 << 20) }),
  z.object({ type: z.literal("abort") }),
  z.object({ type: z.literal("session.new") }),
]);

export type Inbound = z.infer<typeof inbound>;

export type Outbound =
  // `time` and `tz` let the device know what time it is the moment it connects,
  // rather than waiting on SNTP — and at all, on a LAN with no route out.
  | {
      type: "welcome";
      protocol: number;
      device_id: string;
      name: string;
      config: Record<string, unknown>;
      time: number;
      tz: string;
    }
  | { type: "config"; config: Record<string, unknown> }
  | { type: "chat.user"; session_id: string; text: string; origin: "web" | "device" }
  | { type: "chat.delta"; session_id: string; text: string }
  | { type: "chat.done"; session_id: string; usage: { input: number; output: number }; aborted?: boolean }
  | { type: "tool.call"; call_id: string; session_id: string; name: string; args: unknown }
  | { type: "tool.approve"; call_id: string; approved: boolean }
  // The server gave up on a call (turn aborted, or it timed out): drop any approval prompt for it.
  | { type: "tool.cancel"; call_id: string; reason: string }
  // Asks the device to record from its microphone and upload the clip.
  | { type: "audio.record"; clip_id: string; seconds: number }
  // Followed by binary frames carrying `bytes` of JPEG, already sized for the panel.
  | { type: "image.show"; id: string; bytes: number; format: "jpeg"; note?: string }
  // Video: this frame, then interleaved binary media until video.stop. Each binary
  // message is [type u8][pad u8][stream u16 LE][pts_ms u32 LE][payload] — the pad byte
  // is load-bearing, see PROTOCOL.md: without it the PCM starts on an odd address.
  | {
      type: "video.start";
      id: string;
      w: number;
      h: number;
      fps: number;
      stream: number;
      audio: { rate: number; channels: number } | null;
      title?: string;
      duration_ms?: number;
    }
  | { type: "video.stop"; id: string; reason: string }
  | { type: "video.pause"; id: string; paused: boolean }
  | { type: "video.flush"; id: string }
  // What the turn is doing, for the splash the device puts up after a mic press. It
  // showed "transcribing" from the upload until the first reply token, which covered
  // transcription, the model thinking and every tool call. The label is written here
  // rather than on the device so the wording can change without a reflash.
  | { type: "stage"; label: string; detail?: string }
  | { type: "session"; session_id: string | null }
  | { type: "error"; msg: string }
  // Worth telling the device, but not a failure. The device shows these in amber and
  // briefly, rather than the red error screen that made catching silence look like
  // the link had dropped.
  | { type: "notice"; msg: string }
  // Wi-Fi credentials go down, never up. Deliberately not part of `config`: that
  // carries numbers and booleans in both directions, and one string in it would fail
  // the schema above and take every settings report down with it.
  | { type: "wifi.add"; ssid: string; password: string }
  | { type: "wifi.forget"; ssid: string }
  | { type: "notes"; notes: { id: string; seconds: number; at: string }[] }
  | { type: "note.start"; id: string; rate: number; seconds: number; from_ms: number }
  | { type: "note.seek"; id: string; from_ms: number }
  | { type: "note.end"; id: string; reason: string };
