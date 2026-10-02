import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { speakToAgent } from "@/agent/voice";
import { AgentBusyError, dropLink, publishSession, runTurn, startNewSession } from "@/agent/run";
import { wavFromPcm, peakOf } from "@/lib/audio";
import { publish } from "@/lib/bus";
import { listPeers } from "@/lib/db/agents";
import { getClip, listClips, saveClip } from "@/lib/db/clips";
import { findDeviceByToken, getDevice, markAllOffline, updateDevice } from "@/lib/db/devices";
import { logEvent } from "@/lib/db/events";
import { saveToolCall } from "@/lib/db/tool-calls";
import { live, type DeviceLink } from "@/lib/live";
import { NotePlayer } from "@/lib/notes/player";
import { probePeer } from "@/lib/peers";
import type { AudioClip, Device } from "@/lib/types";
import { inbound, PROTOCOL_VERSION, type Outbound } from "./protocol";

const HEARTBEAT_MS = 20_000;
const MAX_CLIP_BYTES = 4 * 1024 * 1024; // ~2 minutes of 16 kHz mono
const MAX_FRAME_BYTES = 256 * 1024;

type Conn = { link: DeviceLink; ip: string | null; alive: boolean; ready: Promise<void> };

function tokenFrom(req: IncomingMessage) {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice(7).trim();
  return new URL(req.url ?? "/", "http://x").searchParams.get("token") ?? undefined;
}

function clientIp(req: IncomingMessage) {
  const fwd = req.headers["x-forwarded-for"];
  const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(",")[0]?.trim();
  return first || req.socket.remoteAddress || null;
}

function reject(socket: Duplex, status: number, text: string) {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

function send(ws: WebSocket, msg: Outbound) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

// A POSIX TZ string for the device's setenv("TZ"). Note the sign is inverted from
// the usual convention — UTC+5:30 is written "IST-5:30" — which is a POSIX quirk,
// not a mistake.
function posixTz(): string {
  const now = new Date();
  const offsetMin = -now.getTimezoneOffset(); // JS gives it the other way round too
  const sign = offsetMin >= 0 ? "-" : "+";
  const abs = Math.abs(offsetMin);
  // Intl often hands back "GMT+5:30", which strips to a bare "GMT" — a label that
  // would be actively wrong for anywhere that is not on it. Each locale only knows
  // the abbreviations used there ("en" gives that for India, "en-IN" gives "IST"), so
  // try a few. The label reaches the agent in list_schedule, where "LOC-5:30" read
  // as UTC-5:30 is a real risk, so a recognisable name is worth the lookup.
  const label =
    ["en-US", "en-IN", "en-GB", "en-AU"]
      .map((locale) =>
        new Intl.DateTimeFormat(locale, { timeZoneName: "short" })
          .formatToParts(now)
          .find((p) => p.type === "timeZoneName")
          ?.value?.replace(/[^A-Za-z]/g, ""),
      )
      .find((n) => n && n.length >= 3 && !((n === "GMT" || n === "UTC") && offsetMin !== 0))
      ?.slice(0, 5) || "LOC";
  return `${label}${sign}${Math.floor(abs / 60)}:${String(abs % 60).padStart(2, "0")}`;
}

export function attachGateway(server: Server, fallbackUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => void) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  const conns = new Map<WebSocket, Conn>();

  markAllOffline().catch((err) => console.error("[gateway] markAllOffline:", err.message));

  // Warm the peer health cache once at boot. Every request path reads that cache and
  // never probes, so without this the first page after a restart shows an attached
  // agent as "not checked yet" -- and the sidebar is a layout, which does not re-render
  // on client navigation, so it would stay that way until a full reload.
  listPeers()
    .then((peers) => {
      if (peers.length) console.log(`> probing ${peers.length} attached agent(s)`);
      return Promise.all(peers.map((p) => probePeer(p).catch(() => null)));
    })
    .catch((err: Error) => console.error("[gateway] peer probe:", err.message));

  server.on("upgrade", async (req, socket, head) => {
    if (new URL(req.url ?? "/", "http://x").pathname !== "/ws") return fallbackUpgrade(req, socket, head);

    const token = tokenFrom(req);
    if (!token) return reject(socket, 401, "Unauthorized");
    let device: Device | null;
    try {
      device = await findDeviceByToken(token);
    } catch (err) {
      console.error("[gateway] auth lookup failed:", (err as Error).message);
      return reject(socket, 503, "Service Unavailable");
    }
    if (!device) return reject(socket, 401, "Unauthorized");

    wss.handleUpgrade(req, socket, head, (ws) => onConnect(ws, device, clientIp(req)));
  });

  function onConnect(ws: WebSocket, device: Device, ip: string | null) {
    // One socket per device: a reconnect replaces the old one.
    live.get(device.id)?.close(4000, "replaced by new connection");
    const link: DeviceLink = {
      ws, device, protocol: 0, tools: [], access: null, activeSessionId: null, pending: new Map(), clipWaiters: new Map(),
    };
    live.attach(link);

    // Frames that arrive while the connection is being recorded wait on `ready`,
    // so the connect event is always logged first.
    const conn: Conn = { link, ip, alive: true, ready: markOnline(device, ip) };
    conns.set(ws, conn);
    ws.on("pong", () => (conn.alive = true));
    ws.on("message", (data, isBinary) =>
      isBinary ? onBinary(conn, data as Buffer) : onMessage(ws, conn, data.toString(), false),
    );
    ws.on("close", (code, reason) => onClose(ws, conn, code, reason.toString()));
    ws.on("error", (err) => console.error(`[gateway] ${device.name}:`, err.message));
  }

  async function markOnline(device: Device, ip: string | null) {
    const now = new Date().toISOString();
    try {
      await updateDevice(device.id, { status: "online", ip, last_seen_at: now });
      publish({ kind: "presence", deviceId: device.id, status: "online", ip, at: now });
      await logEvent({ device_id: device.id, type: "connect", summary: `connected from ${ip ?? "unknown"}` });
    } catch (err) {
      console.error("[gateway] markOnline:", (err as Error).message);
    }
  }

  async function onMessage(ws: WebSocket, conn: Conn, raw: string, isBinary: boolean) {
    await conn.ready;
    const { link } = conn;
    const device = link.device;
    conn.alive = true;
    if (isBinary) return; // handled by onBinary

    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return send(ws, { type: "error", msg: "invalid JSON" });
    }
    const parsed = inbound.safeParse(json);
    if (!parsed.success) return send(ws, { type: "error", msg: parsed.error.issues[0]?.message ?? "invalid message" });
    const msg = parsed.data;

    try {
      switch (msg.type) {
        case "hello": {
          await updateDevice(device.id, { firmware: msg.fw ?? null, hw: msg.hw ?? null, last_seen_at: new Date().toISOString() });
          link.device = (await getDevice(device.id)) ?? device;
          link.protocol = msg.protocol ?? 0;
          link.tools = msg.tools ?? [];
          link.capabilities = msg.capabilities ?? [];
          link.access = msg.access ?? null;
          send(ws, {
            type: "welcome",
            protocol: PROTOCOL_VERSION,
            device_id: link.device.id,
            name: link.device.name,
            config: link.device.config,
            // Seconds, because the device sets a time_t with it. The timezone is
            // this machine's, which is the one the person setting an alarm means.
            time: Math.floor(Date.now() / 1000),
            tz: posixTz(),
          });
          publishSession(link, { type: "access", access: link.access, tools: link.tools.length });
          const extra = link.tools.length ? ` · ${link.tools.length} tools · access ${link.access?.level ?? "?"}` : "";
          await logEvent({
            device_id: device.id,
            type: "log",
            summary: `hello fw=${msg.fw ?? "?"} hw=${msg.hw ?? "?"}${extra}`,
            payload: { capabilities: msg.capabilities ?? [], tools: link.tools.map((t) => t.name), access: link.access },
          });
          break;
        }
        case "access":
          link.access = { level: msg.level, remote_approval: msg.remote_approval };
          publishSession(link, { type: "access", access: link.access, tools: link.tools.length });
          await logEvent({
            device_id: device.id,
            type: "action",
            level: msg.level === "yolo" ? "warn" : "info",
            summary: `access level → ${msg.level}${msg.remote_approval ? "" : " (remote approval off)"}`,
          });
          break;
        case "log":
          await logEvent({ device_id: device.id, type: msg.level === "error" ? "error" : "log", level: msg.level, summary: msg.msg });
          break;
        case "event":
          await logEvent({
            device_id: device.id,
            type: msg.event,
            level: msg.event === "error" ? "error" : "info",
            summary: msg.summary,
            payload: msg.payload ?? null,
          });
          break;
        case "settings": {
          // Merge rather than replace: the config column may hold keys this
          // firmware does not know about, and dropping them here would quietly
          // lose them on the next connect.
          const merged = { ...(link.device.config ?? {}), ...msg.settings };
          await updateDevice(device.id, { config: merged });
          link.device = { ...link.device, config: merged };
          publish({ kind: "device", deviceId: device.id, config: merged });
          break;
        }
        case "wifi.networks": {
          link.wifi = { ssids: msg.ssids, current: msg.current };
          break;
        }
        case "notes.list": {
          const clips = (await listClips(device.id, 40)).filter((c) => c.source === "note");
          send(ws, {
            type: "notes",
            notes: clips.slice(0, 12).map((c) => ({ id: c.id, seconds: c.seconds, at: c.created_at })),
          });
          break;
        }
        case "note.play": {
          const clip = await getClip(msg.id);
          if (!clip || clip.device_id !== device.id) {
            send(ws, { type: "note.end", id: msg.id, reason: "no such note" });
            break;
          }
          link.note?.stop("replaced");
          const player = new NotePlayer(link, clip);
          player.fromMs = msg.from_ms;
          link.note = player;
          void player.start(clip).catch((e: Error) => player.stop(e.message));
          break;
        }
        case "note.stop":
          link.note?.stop("stopped by the device");
          break;
        case "note.ready":
          link.note?.grant(msg.bytes);
          break;
        case "video.control":
          link.video?.control(msg.action);
          break;
        case "chat":
          await runTurn(link, msg.text, "device", msg.session_id);
          break;
        case "tool.pending": {
          const pending = link.pending.get(msg.call_id);
          if (!pending) break;
          pending.awaitingApproval();
          pending.row.status = "awaiting_approval";
          pending.row.reason = msg.reason;
          await saveToolCall(pending.row);
          publishSession(link, { type: "tool", call: { ...pending.row } });
          break;
        }
        case "tool.result":
          link.pending.get(msg.call_id)?.resolve({
            ok: msg.ok,
            output: msg.output,
            error: msg.error,
            denied: msg.denied,
            decided_by: msg.decided_by,
          });
          break;
        case "audio.start":
          link.upload = {
            clipId: msg.clip_id,
            sampleRate: msg.sample_rate,
            channels: msg.channels,
            source: msg.source,
            note: msg.note,
            prompt: msg.prompt,
            chunks: [],
            bytes: 0,
            startedAt: Date.now(),
          };
          publishSession(link, { type: "audio", state: "recording", clip_id: msg.clip_id });
          break;
        case "audio.end":
          await finishUpload(link, msg.clip_id, msg.aborted ?? false);
          break;
        case "video.ready":
          if (link.video?.id === msg.id) link.video.credit(msg.video_credits, msg.audio_credits);
          break;
        case "video.ended":
          if (link.video?.id === msg.id) link.video.stop(msg.reason ?? "the device stopped it");
          await logEvent({
            device_id: device.id,
            type: "action",
            summary: `video ended: ${msg.shown} frames shown, ${msg.dropped} dropped`,
          });
          break;
        case "abort":
          link.run?.abort.abort();
          break;
        case "session.new":
          startNewSession(link);
          break;
      }
    } catch (err) {
      const text = (err as Error).message;
      send(ws, { type: "error", msg: text });
      if (!(err instanceof AgentBusyError)) {
        await logEvent({ device_id: device.id, type: "error", level: "error", summary: `${msg.type}: ${text}` }).catch(() => {});
      }
    }
  }

  // Audio arrives as raw PCM in binary frames, between audio.start and audio.end.
  async function onBinary(conn: Conn, chunk: Buffer) {
    await conn.ready;
    conn.alive = true;
    const upload = conn.link.upload;
    if (!upload) return; // nothing is being recorded; ignore
    if (upload.bytes + chunk.byteLength > MAX_CLIP_BYTES) {
      conn.link.upload = undefined;
      send(conn.link.ws, { type: "error", msg: "clip too long; recording dropped" });
      settleClip(conn.link, upload.clipId, null, "clip exceeded the size limit");
      return;
    }
    upload.chunks.push(chunk);
    upload.bytes += chunk.byteLength;
  }

  function settleClip(link: DeviceLink, clipId: string, clip: AudioClip | null, error?: string) {
    link.clipWaiters.get(clipId)?.(clip, error);
    link.clipWaiters.delete(clipId);
  }

  async function finishUpload(link: DeviceLink, clipId: string, aborted: boolean) {
    const upload = link.upload;
    link.upload = undefined;
    if (!upload || upload.clipId !== clipId) return;
    if (aborted || upload.bytes === 0) {
      settleClip(link, clipId, null, aborted ? "the device aborted the recording" : "no audio was captured");
      return;
    }

    publishSession(link, { type: "audio", state: "uploading", clip_id: clipId });
    const pcm = Buffer.concat(upload.chunks);
    const seconds = pcm.byteLength / (upload.sampleRate * upload.channels * 2);
    try {
      const clip = await saveClip(wavFromPcm(pcm, { sampleRate: upload.sampleRate, channels: upload.channels, bits: 16 }), {
        device_id: link.device.id,
        session_id: link.activeSessionId,
        seconds: Math.round(seconds * 100) / 100,
        sample_rate: upload.sampleRate,
        channels: upload.channels,
        peak: peakOf(pcm),
        source: upload.source,
        note: upload.note ?? null,
      });
      publishSession(link, { type: "clip", clip });
      settleClip(link, clipId, clip);
      // Push-to-talk: the device held its button, so turn the clip into a prompt.
      if (upload.prompt) void answerSpokenClip(link, clip);
      await logEvent({
        device_id: link.device.id,
        type: "action",
        summary: `recorded ${clip.seconds.toFixed(1)}s of audio (peak ${Math.round((clip.peak ?? 0) * 100)}%)`,
        payload: { clip_id: clip.id, bytes: clip.bytes, source: clip.source },
      });
    } catch (err) {
      const msg = (err as Error).message;
      console.error("[gateway] clip:", msg);
      settleClip(link, clipId, null, msg);
      send(link.ws, { type: "error", msg: `clip not stored: ${msg}` });
      await logEvent({ device_id: link.device.id, type: "error", level: "error", summary: `clip not stored: ${msg}` }).catch(() => {});
    }
  }

  // A clip the device flagged as speech: transcribe it, then answer it. Failures are
  // reported to the device so the panel can say what went wrong.
  async function answerSpokenClip(link: DeviceLink, clip: AudioClip) {
    try {
      const heard = await speakToAgent(link, clip, "device");
      if (heard.prompted) {
        await logEvent({
          device_id: link.device.id,
          type: "action",
          summary: `heard "${heard.text.slice(0, 120)}"`,
          payload: { clip_id: clip.id },
        });
      } else {
        // Silence and a busy agent are ordinary outcomes of pressing the mic, not
        // faults. Anything else — a missing API key, say — really is broken.
        const reason = heard.reason ?? "nothing was said";
        const ordinary = reason === "nothing was said" || reason === "the agent is busy";
        send(link.ws, { type: ordinary ? "notice" : "error", msg: reason });
      }
    } catch (err) {
      const msg = (err as Error).message;
      console.error("[gateway] speech:", msg);
      send(link.ws, { type: "error", msg: `could not transcribe that: ${msg}` });
    }
  }

  async function onClose(ws: WebSocket, conn: Conn, code: number, reason: string) {
    await conn.ready;
    conn.link.video?.stop("device disconnected");
    conn.link.note?.stop("device disconnected");
    conns.delete(ws);
    const { link } = conn;
    const device = link.device;
    dropLink(link);
    // A replaced socket shouldn't flip the device offline.
    if (!live.release(device.id, ws)) return;

    const now = new Date().toISOString();
    try {
      await updateDevice(device.id, { status: "offline", last_seen_at: now });
      publish({ kind: "presence", deviceId: device.id, status: "offline", at: now });
      await logEvent({
        device_id: device.id,
        type: "disconnect",
        level: code === 1000 || code === 4001 ? "info" : "warn",
        summary: `disconnected (${code}${reason ? ` ${reason}` : ""})`,
      });
    } catch (err) {
      console.error("[gateway] onClose:", (err as Error).message);
    }
  }

  const heartbeat = setInterval(() => {
    for (const [ws, conn] of conns) {
      if (!conn.alive) {
        ws.terminate();
        continue;
      }
      conn.alive = false;
      ws.ping();
    }
  }, HEARTBEAT_MS);
  wss.on("close", () => clearInterval(heartbeat));

  return wss;
}
