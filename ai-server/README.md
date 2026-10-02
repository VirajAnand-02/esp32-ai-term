# ai-server

Control server for the ESP32 AI terminals: a WebSocket gateway that devices connect to, the LLM behind them (Vercel AI SDK: DeepSeek by default, Anthropic/OpenAI/Google also wired), and an admin dashboard. Built with Next.js 16 and Supabase, and deploys to Railway.

```
 ESP32 / CLI / browser ──ws──▶ /ws gateway ──▶ AI SDK (deepseek | anthropic | openai | google)
                                   │
                                   ├──▶ Supabase (devices, events, sessions, messages, memories)
                                   └──▶ in-process bus ──SSE──▶ dashboard (/api/stream)
```

## Setup

1. **Install**: `pnpm install`
2. **Supabase**: create a project, then run the files in `supabase/migrations/` in order (`0001_init.sql` … `0004_transcripts.sql`) in the SQL editor.
   Under *Project Settings → API Keys*, copy the project URL and a **secret key** (`sb_secret_…`).
   The legacy anon/service_role JWT keys aren't used. The browser never talks to Supabase directly: every query runs on the server, and RLS is on with no policies.
3. **Env**: copy `.env.example` to `.env.local` and fill in `ADMIN_PASSWORD`, `SESSION_SECRET` (32+ random chars), the Supabase URL and secret key, and `DEEPSEEK_API_KEY` (or another provider key). `GROQ_API_KEY` turns on speech to text, and `TAVILY_API_KEY` turns on web search.
4. **Demo data** (optional): `pnpm seed` (or `pnpm seed --reset` to wipe first). It prints a token for each demo device.
5. **Run**: `pnpm dev`, then open http://localhost:3000.

## Agent mode

Clients such as `../cli-client` can offer **tools** (read files, run commands, …). The agent loop runs here: the model calls a tool, the server sends `tool.call` to the device, and the device's own policy decides whether it runs. It may ask its user, or let the dashboard approve.

- **Live tab** (Devices → a device): the device's shared session. Watch it stream, send prompts as that device, approve or deny pending calls, abort, or start a new session. Everything also shows on the device itself.
- **Access levels** (`readonly` / `standard` / `trusted` / `yolo`) are set on the device only. The dashboard shows them (YOLO pulses red) but can't change them.
- Tool calls are stored in `tool_calls` (migration 0002). Without that migration the agent still works; the call history just isn't saved.

## The fleet tools — every device is an access point

There is one agent, not two. The **console** page runs it in the dashboard, and each device runs it in that
device's live session, and both get the same fleet tools (`src/agent/master.ts`, `fleetTools()`):

| tool | what it does |
| --- | --- |
| `list_devices` / `device_tools` | fleet status, access levels, and each device's tool schemas |
| `call_device_tool` | one precise action on a device, e.g. read a file or run a command; can fan out to several devices in parallel |
| `ask_device` | hands a whole task to a device's own agent, in that device's live session (visible on the device) |
| `recent_activity` | reads the event log for one device or the whole fleet |

So you can stand at the ESP32 terminal, ask it to read a sensor on another machine, and it will — no walking
over to the dashboard. The event lands on the target device's log naming the caller (`bench-peer: ai-term-01:
read_sensor ok`).

**No one bypasses a device's policy.** A call always goes through the target's own permission checks and
approvals; being asked from elsewhere grants nothing extra. Calls that need a human show up in the console's
**approvals** panel, on the device, and in its live tab.

An agent running on a device is told which roster line is its own, and `ask_device` and `call_device_tool`
refuse to target it — it does its own work directly. Delegation chains are bounded by the busy check: every
device already in the chain is mid-turn, so a cycle comes straight back as "busy".

One roster line is not a machine: see **attached agents** below.

## Attached agents — OpenClaw, NanoClaw, Hermes

An **attached agent** is a device of kind `agent` whose transport is HTTP-out instead of WebSocket-in: nothing
connects to us, the server calls it. It exists so the long, messy work this fleet is bad at — reading a repo,
writing and running code, driving a browser — can go to a harness built for it instead of being rebuilt here.

OpenClaw and Hermes both landed on the same front door, an OpenAI-compatible
`POST /v1/chat/completions` behind a bearer token, so `src/lib/peers.ts` is **one client rather than one
integration per harness** and anything else that speaks it is a row in `agent_peers`.

Register it in **Settings → devices** with kind `agent`, then set its base url, key and timeout on the
device's **endpoint** tab. Typical urls: OpenClaw `:18789`, Hermes `:8642`. `/v1` is added if the url does not
already end in it.

**NanoClaw is the exception and needed a bridge.** It has no HTTP surface at all — it talks to people
through messaging apps and to its own containers through two SQLite files — so there is nothing here to
point a base url at. What it does have is a *channel* interface, the seam its Slack and Telegram adapters
are generated into, and that is where the bridge lives: `src/channels/aiterm.ts` in the NanoClaw checkout
serves `/v1/chat/completions` and `/v1/models`, hands the task to its router, and answers with the agent's
first reply. A reply with no request waiting for it — a later streaming chunk, or a scheduled job speaking
up on its own — is POSTed to `/api/peers/inbox` instead, so both halves work. Nothing on this side knows
the difference. Setup is in `E:\programming\nanoclaw` (`docs/aiterm-channel.md` there).

- **Reaching one:** `ask_device(name, task)`, the same tool as for a device. `device_tools` and
  `call_device_tool` refuse — a harness exposes no tool list.
- **Waiting:** an answer within **60 s** comes back inline. Past that the task is **handed off**: the tool
  returns a job id, the request keeps running, and the answer arrives as a `notice` on the asking device —
  which the firmware's `on_notice` already turns into a notification in the drawer. `agent_job(id)` reads the
  full text. Aborting the turn also counts as handing off, so the answer is never lost.
- **One task at a time** per peer, the same bound `link.run` puts on delegating to a device.
- **Each request is self-contained.** The endpoint is stateless and only the task is sent, so the harness
  starts fresh and its own memory does the remembering.
- **Talking back** — the half that lets it speak first:

  ```bash
  curl -XPOST "$SERVER/api/peers/inbox" \
    -H "Authorization: Bearer <the agent device's token>" \
    -H "content-type: application/json" \
    -d '{"text":"the deploy finished","device":"ai-term-01"}'
  ```

  `device` is optional while there is only one it could mean. It lands as a notification on the panel; the
  reply says `delivered: false` if the device was not connected, because the notice is dropped rather than
  queued. Deliberately not a message row: an unprompted line is a notification, not a conversation turn.

Two things that bite:

- **`/api/peers/*` is excluded from the proxy's admin-cookie check** (`src/proxy.ts`) and authenticates itself
  with the peer's device token, exactly as `/ws` does. Any route added under it must do the same — and any
  *other* route an outside system posts to needs the same exclusion, or it 401s before your code runs.
- **Jobs are in-process.** A restart loses anything outstanding; the `tool_calls` row is left `running`.
- The key is sent to the harness, so it cannot be hashed like `token_hash`. It lives in `agent_peers.api_key`
  in plaintext and is never returned to the browser — which is why that table is a sidecar rather than part of
  `devices.config`, since `config` is in every device read.

## Scripts

| script | what it does |
| --- | --- |
| `pnpm dev` | custom server (`server.ts`) in dev mode: Next + `/ws` gateway |
| `pnpm build` / `pnpm start` | production build / serve |
| `pnpm seed [--reset]` | demo devices, events, sessions, memories |
| `pnpm fake-device <token> [ws-url]` | simulated ESP32: hello, logs, events, streamed chat, and two pretend tools (`read_sensor`, `set_led`, which needs approval) (`--no-chat`, `--quiet`) |
| `pnpm typecheck` / `pnpm lint` | |

The gateway is loaded once by `server.ts`, so changes under `src/gateway/` need a restart. Pages and API routes hot-reload as usual.

## Deploy on Railway

1. Create a service from this folder (set the root directory to `ai-server` if the repo also contains the firmware).
2. Add the env vars from `.env.example`. Railway sets `PORT` itself.
3. `railway.json` sets the build command, `pnpm start`, and a health check on `/api/health`.
4. Devices connect to `wss://<your-app>.up.railway.app/ws`.

Keep it at **one replica**. Live presence and the SSE bus live in the process, so a second replica wouldn't see the first one's devices.

## Deploy on Render

[DEPLOY-RENDER.md](DEPLOY-RENDER.md) is the long version, and it is longer than the Railway
notes above because three things need deciding rather than copying: a Dockerfile if you want
ffmpeg (the plain Node runtime has none, so every server-side video source fails), a git
repository whose `.gitignore` is written *before* the first commit, and a new home for the
attached agent — a peer pointing at `127.0.0.1:18790` means the Render container once the
server lives there, where nothing is listening.

## What's wired and what isn't

| area | status |
| --- | --- |
| admin login (env credentials, signed cookie, rate limit) | working |
| device registry, tokens (hashed), rename, rotate, delete | working |
| WebSocket gateway: auth, presence, heartbeat, logs, events, streamed chat | working |
| live dashboard, logs explorer, device timeline and sessions | working |
| per-device config (saved, sent in `welcome`, pushed live) | working (firmware must read it) |
| agent tools on devices, approvals (device or web), live shared sessions, abort | working |
| LLM settings, test bench, browser console | working |
| memories CRUD | working (not injected into prompts yet) |
| audio: record on a device, play back, download, delete | working |
| speech to text (Groq `whisper-large-v3-turbo`) | working |
| display tools and the display test tab | working |
| speaker tools (tones, named sounds, melodies, volume) | working |
| images: agent finds one, server crops and scales it, device shows it | working |
| video with sound: ffmpeg → MJPEG + PCM, ~12 fps at 240x240 | working |
| web search: Tavily, so the agent's urls are real ones | working |
| vector store, external DBs, backups | UI only, marked `[offline]` |

## Web search

With `TAVILY_API_KEY` set, the agent gets a **web_search** tool (`src/lib/search.ts`) on every device, and
the master console gets the same one: `query`, plus an optional `site` to restrict it to one domain. It
returns five results as title, url and a 300-character extract, and runs on the server like `show_image` and
the video tools, so it shows up in the live tab as a `read` tool call.

The reason it exists is urls. Asked for a YouTube link the model writes one that is well formed, plausible
and made up, and `play_youtube` only discovers this a minute later when yt-dlp fails. The tool description
and the system prompt both say the same thing: search first, then use a url from the results.

## Audio and speech

A device that advertises `record_audio` can be recorded from the **audio** tab: the clip streams up as 16-bit PCM, is stored as a WAV in a private Supabase bucket, and plays back through this server (the bucket stays closed to the internet).

With `GROQ_API_KEY` set, clips can be transcribed with `whisper-large-v3-turbo` (override with `TRANSCRIBE_MODEL`):

- The **mic button** in the live tab records for a few seconds, transcribes, and sends the text as a prompt in one go. The seconds toggle next to it cycles 4 → 6 → 10 → 15.
- A device can do the same by itself: **hold its push-to-talk button**, speak, let go. The clip goes up with `prompt: true` on `audio.start`, and the gateway transcribes it and runs the turn. Both paths share `src/agent/voice.ts`.
- Individual clips have a **transcribe** link in the audio tab. The text is stored on the clip (migration 0004), so it only runs once.
- Whisper never returns an empty string for silence; it invents a stock phrase. Those are filtered out, and nothing is sent to the agent.

## Video

A device whose firmware advertises the `video` capability can play video with sound. ffmpeg on the server
transcodes any source to 240x240 baseline MJPEG plus 22.05 kHz mono PCM, and streams both over the
websocket; the device decodes each frame straight to the panel and plays the audio through its amplifier.

Sources: a direct url, a file on the server, YouTube (needs **yt-dlp**), and —
while the server runs on a Windows machine — the screen or a webcam. Drive it from the **video** tab on the
device page, or let the agent do it with `play_video`, `play_youtube`, `mirror_screen` and `stop_video`.

Measured on the real hardware: the server delivers **144 of 144 frames with none dropped** and audio at its
full 43 KB/s, and the device shows **120 of them, 24 late** — about **10 fps** against a 12 fps target. The
remaining loss is the device's decode budget, not the link: ~60 ms a frame leaves ~16 fps with nothing else
running, and ~10 with audio, wifi and the credit loop alongside.

Settled after measurement, against several plausible changes that turned out worse: **22.05 kHz mono** audio
(40 kHz costs 3-4 fps and fixed nothing), **four** frame slots (eight just aged frames in the queue and
tripled late frames), and **4 KB** audio messages.
The ceiling is the panel, not the network — a full 240x240 frame takes ~50 ms to push at 20 MHz, so ~16 fps
is flat out and 12 leaves headroom. Audio is the master clock; late video frames are dropped rather than
letting the sound stutter.

**yt-dlp** is found either on `PATH` or as a binary sitting in the `ai-server` folder, which is the easiest
way to have it (it is a single self-contained executable, and `.gitignore` keeps it out of the repo). Two
flags it needs, both easy to miss: `--js-runtimes node`, because current yt-dlp needs a JS runtime to solve
YouTube's challenge and only enables deno by default; and merging to matroska, because YouTube no longer
offers muxed formats so a plain `best` selector matches nothing.

**ffmpeg must be on the server.** It is not part of the Railway build (`railway.json` uses RAILPACK with no
`nixpacks.toml` or `Dockerfile`), so every server-side source works in dev and fails in production until it
is added.

## Display

A device with an ST7789 panel advertises `display_text`, `display_fill`, `display_pattern` and `display_backlight`. The **display** tab drives them directly through `POST /api/devices/[id]/tool`, with no model in the loop — text with a title and size, colour fills, colour-bar / grid / gradient test patterns, and a backlight slider. Every call is still logged in the device's session and still goes through the device's own permission policy.

Device protocol: see [PROTOCOL.md](./PROTOCOL.md).
