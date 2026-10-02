# Device protocol v1

JSON text frames over a WebSocket at `/ws`. Binary frames carry raw audio, between `audio.start` and `audio.end`.

v1 adds agent tools and shared sessions. It's additive: a v0 client that never sends `tools` just chats.

## Connect

```
GET /ws
Authorization: Bearer <device token>
```

If a client can't set headers, it can use `/ws?token=<device token>` instead. A bad token gets `401` before the upgrade.
Tokens are issued in *Settings → Devices*. Only their sha256 is stored.

- **One socket per device.** A new connection replaces the old one, which is closed with `4000`. A client should stop, not reconnect, on `4000`.
- **Heartbeat.** The server pings every 20 s. A client that doesn't pong before the next ping is dropped.
- **Close codes.** `4001` = closed by an admin, token rotated, or device removed.
- **Limits.** 256 KB max per frame. Only one agent turn can run per device at a time.

## The agent model

The model runs on the server. A device can offer **tools** in `hello`, and the agent calls them with `tool.call`.

**The device alone decides whether a call runs.** It answers every call with `tool.result`. If a call needs a human, the device sends `tool.pending` first; approval can then come from the device's own UI or, when the device allows it (`remote_approval`), from the dashboard via `tool.approve`. The server can never make a device run something its policy denies.

**Sessions are server-owned.** Each device has one active session, shared by the device and the dashboard. Prompts from either side go into it, and everything streams to both.

## Device → server

```jsonc
{ "type": "hello", "protocol": 1, "fw": "aiterm-cli 0.1.0", "hw": "Windows-11",
  "capabilities": ["chat", "log", "tools"],
  "tools": [{ "name": "read_file", "description": "…", "parameters": { /* JSON Schema */ }, "risk": "read" }],
  "access": { "level": "standard", "remote_approval": true } }

{ "type": "access", "level": "trusted", "remote_approval": true }      // level changed on the device
{ "type": "chat", "text": "what's in ~/docs?", "session_id": "<optional uuid>" }
{ "type": "tool.pending", "call_id": "…", "reason": "changes an existing file" }
{ "type": "tool.result", "call_id": "…", "ok": true, "output": "…", "decided_by": "policy" }
{ "type": "tool.result", "call_id": "…", "ok": false, "error": "not allowed: …", "denied": true, "decided_by": "web" }
{ "type": "abort" }                                                     // stop the current turn
{ "type": "session.new" }                                               // start a fresh session
{ "type": "log", "level": "info", "msg": "…" }                          // debug|info|warn|error
{ "type": "event", "event": "action", "summary": "…", "payload": {} }   // command|action|error

// the device's own settings, on connect and whenever one is committed on the device.
// the server merges them into the device row, so the dashboard shows what the
// hardware has rather than the last thing it was sent.
{ "type": "settings", "settings": { "display_brightness": 70, "volume": 35, "ui_sounds": true } }

// audio: audio.start, then binary frames of raw PCM, then audio.end
{ "type": "audio.start", "clip_id": "…", "sample_rate": 16000, "channels": 1,
  "source": "mic", "note": "…", "prompt": true }
{ "type": "audio.end", "clip_id": "…", "aborted": false }

// video flow control: a grant of extra room, not a report of how much is free
{ "type": "video.ready", "id": "…", "video_credits": 2, "audio_credits": 8192 }
{ "type": "video.ended", "id": "…", "shown": 133, "dropped": 3, "reason": "finished" }

// the transport keys during playback. the server owns the position, because only it
// can decode the source; the device's d-pad and its /v console command both land here.
{ "type": "video.control", "id": "…", "action": "pause" }   // pause|resume|seek_back|seek_fwd

// voice notes: clips recorded on the device with `prompt: false`, played back on its
// own speaker. note.ready is a grant of bytes, exactly like video.ready.
{ "type": "notes.list" }
{ "type": "note.play", "id": "…", "from_ms": 0 }
{ "type": "note.stop" }
{ "type": "note.ready", "bytes": 4096 }
```

- `risk` is one of `info`, `read`, `create`, `modify`, `destructive` or `exec`. It's shown to the user and helps the model; enforcement is the device's job.
- `decided_by` is `policy`, `device`, `web`, `timeout` or `cancelled`.
- **Audio.** Between `audio.start` and `audio.end` every binary frame is signed 16-bit little-endian PCM at the
  declared rate. The server assembles them, writes a WAV to private storage and rows it in `audio_clips`. A clip
  over 4 MB is dropped. `source` is `mic`, `web` or `agent`.
- **Video.** After `video.start` every binary message is media, framed as
  `[type u8][pad u8][stream u16 LE][pts_ms u32 LE][payload]`, type 1 for a JPEG frame and 2 for PCM.
  The pad byte is not spare: without it the payload starts on an odd address, and the device casts PCM
  straight to `int16_t*` — an unaligned 16-bit load on Xtensa returns rubbish, which sounds like
  distortion rather than an obvious failure.
  `pts_ms` is measured from the first media the server emits. The device aligns that against its own
  audio clock **on the first frame** and works relative to the offset thereafter: the two origins differ
  by however long ffmpeg took to start, and without the alignment every frame looks early, waits the
  full cap, and the cap silently becomes the frame rate. A frame more than 100 ms late is dropped,
  because the audio cannot be paused to wait for it.
- **Video credit is a grant, not a level.** `video.ready` says how much room has just been *freed*, and
  the server adds it to what it is allowed to send. Reporting free space instead is racy: bytes already
  in flight are not yet in the ring, so the server tops itself back up and overruns the device. That bug
  cost half the frames before it was found.
- **Images.** `image.show` is followed by binary frames holding a baseline JPEG, already cropped and scaled to the
  panel by the server. Baseline only: the decoder on the device does not read progressive JPEG.
- **`prompt: true`** means push-to-talk: the server transcribes the clip (Groq `whisper-large-v3-turbo`) and runs
  the text as a turn on that device, exactly as if it had been typed. Silence is filtered out and nothing is sent.

## Server → device

```jsonc
// `time` (unix seconds) and `tz` (a POSIX TZ string) tell the device what time it is the
// moment it connects, rather than waiting on SNTP — and at all, on a LAN with no route out.
// POSIX inverts the sign: UTC+5:30 is written "-5:30".
{ "type": "welcome", "protocol": 1, "device_id": "…", "name": "laptop", "config": { … },
  "time": 1759190400, "tz": "IST-5:30" }
{ "type": "config", "config": { … } }                                   // admin saved new config
// config and settings carry the same keys in both directions. The device clamps
// every value to its own range and stores the result in NVS, so a push is a
// request rather than an assignment, and what comes back up is the truth.
{ "type": "chat.user", "session_id": "…", "text": "…", "origin": "web" } // a prompt sent from the dashboard
{ "type": "chat.delta", "session_id": "…", "text": "…" }                // streamed reply (any origin)
{ "type": "chat.done", "session_id": "…", "usage": { "input": 412, "output": 9 }, "aborted": false }
{ "type": "tool.call", "call_id": "…", "session_id": "…", "name": "read_file", "args": { … } }
{ "type": "tool.approve", "call_id": "…", "approved": true }            // decided in the dashboard
{ "type": "tool.cancel", "call_id": "…", "reason": "aborted by the user" } // drop any prompt for it
{ "type": "session", "session_id": null }                               // a new session was started
{ "type": "audio.record", "clip_id": "…", "seconds": 5 }                // the dashboard wants a clip
{ "type": "image.show", "id": "…", "bytes": 14805, "format": "jpeg" }   // then the JPEG, as binary frames
{ "type": "video.start", "id": "…", "w": 240, "h": 240, "fps": 12, "stream": 3,
  "audio": { "rate": 22050, "channels": 1 } }                          // then interleaved media
{ "type": "video.stop", "id": "…", "reason": "finished" }
{ "type": "video.pause", "id": "…", "paused": true }                    // the answer to video.control
{ "type": "video.flush", "id": "…" }                                    // a seek landed: drop what is buffered
{ "type": "error", "msg": "…" }

// worth telling the device, but not a failure. shown briefly in amber rather than on
// the red error screen — catching silence used to look like the link had dropped.
{ "type": "notice", "msg": "nothing was said" }

// what the turn is doing, for the splash a mic press puts up. the device starts on
// "transcribing" by itself and relabels on each of these: "running agent" when the
// model starts, then each tool by name, then back to "running agent" when it returns.
// chat.delta ends the splash by moving to the reply screen, so there is no "done".
// the wording is chosen here, not on the device, so it can change without a reflash.
{ "type": "stage", "label": "running agent", "detail": "deepseek:deepseek-v4-flash" }
{ "type": "stage", "label": "web_search", "detail": "running a tool" }

// voice notes, in answer to notes.list / note.play. note.start is followed by the same
// binary media framing as video, type 2 (PCM) on stream 0.
{ "type": "notes", "notes": [{ "id": "…", "seconds": 4.2, "at": "2026-09-28T19:04:11Z" }] }
{ "type": "note.start", "id": "…", "rate": 16000, "seconds": 4.2, "from_ms": 0 }
{ "type": "note.seek", "id": "…", "from_ms": 10000 }
{ "type": "note.end", "id": "…", "reason": "finished" }
```

- `chat.done` is always the last frame of a turn. A device can send its next `chat` as soon as it sees it.
- A text reply can be split around tool calls: text, then `tool.call` / `tool.result`, then more text.
- A turn waits up to 60 s for a `tool.result`, or 10 min once `tool.pending` arrives, then cancels the call.

Everything a device sends is stored as an event and shows up live on the dashboard.
