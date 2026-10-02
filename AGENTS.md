# esp32-ai-term — orientation for agents

An ESP32-S3 "AI terminal": a small handheld box with a screen, a microphone, a speaker
and six keys that talks to an LLM. Three parts live here.

| part | what it is |
| --- | --- |
| `main/`, `components/` | the firmware (ESP-IDF 6.1, C and C++) |
| `ai-server/` | Next.js 16 control server: `/ws` gateway, the agent, the dashboard. Has its own [README](ai-server/README.md) and [PROTOCOL.md](ai-server/PROTOCOL.md) — read those before touching the server |
| `cli-client/` | a Python TUI that speaks the same protocol; useful as a second "device" without hardware |

The firmware's job, as the owner put it, is "to basically properly make the OS firmware":
a dashboard, a launcher, apps (clock, timer, pomodoro, alarms, stopwatch, voice notes,
settings, sounds, diagnostics), settings that survive a reset, and the agent terminal as
one app among them rather than the whole device.

## The one architectural rule

**Hardware lives behind components; app code never touches a GPIO.**

```
main/            app_main.c, the wiring (board_config.h), device tools, the serial console
components/bsp/  display, keys, button, mic, speaker, status LED — the only code that knows a pin exists
components/ui/   the compositor: screen stack, key routing, idle dim, the terminal screens
components/apps/ shell (launcher + every app), notes (player), video (player)
components/proto/ wifi + the saved-network store, mDNS, the websocket client
components/settings/ the NVS-backed settings table
components/clock/ time (SNTP + server) and the schedule (timers, alarms, prompts)
components/notify/ the notification ring, and the LED's side of it
components/sounds/ the tone bank
```

Every pin number is in `main/board_config.h` and reaches a driver through an init struct.
A new app goes in `components/apps/shell/` as a `ui_app_t` and is added to the launcher
table in `shell.cpp`; `components/apps/` is scanned only one level deep, so a new
*component* there also needs a line in the root `CMakeLists.txt`.

## Build, flash, watch

```powershell
. C:\Espressif\tools\Microsoft.v6.1.PowerShell_profile.ps1   # export.ps1 does NOT work here
idf.py build
idf.py -p COM10 flash
```

COM10 is the chip's own USB-Serial-JTAG, not a UART bridge. Two consequences that have
cost real time:

- Resetting the board drops the USB device, so any open serial handle dies. Close it,
  wait ~1.5 s for re-enumeration, reopen — and accept that the first ~1.8 s of boot log
  is gone.
- `idf.py monitor` holds the port and blocks flashing. For scripted testing, open COM10
  with pyserial at 115200 with `dtr = rts = False` (see the scratch scripts pattern:
  write a command, drain for N seconds, filter the noisy tags).

## Driving the device without hands on it

This is the most useful thing in the repo for an agent and it is easy to miss. The serial
console in `app_main.c` injects input at the driver level, so the whole interface can be
tested over the cable:

| command | what it does |
| --- | --- |
| `/key up\|down\|left\|right\|ok\|back` | puts a key event on the queue |
| `/press <key>` | drives that key's **pin** low and releases it — the real interrupt, debounce and queue path |
| `/tap [ms]` | presses the mic button; two in quick succession is the voice-note gesture |
| `/talk [s]` | what holding the mic button does — records and sends as a prompt |
| `/note` | starts/stops a continuous voice note |
| `/screen` | **the assertion**: screen name, stack depth, backlight %, LED state, unread notifications |
| `/power` | whether power saving is on, and every PM lock currently held |
| `/menu` | opens the launcher |
| `/set [key value]` | lists or changes a setting |
| `/time`, `/timer <s>`, `/cancel <id>`, `/pomo [start\|skip\|stop]` | clock and schedule |
| `/todo [add\|daily <text>] [ok\|del <n>]` | the todo list, over a flat index: every daily first, then the rest |
| `/v pause\|resume\|seek_back\|seek_fwd` | video transport |
| `/new`, `/abort` | session control |
| `/bench`, `/soak [s]` | panel throughput and a soak test |
| anything else | sent to the agent as a prompt |

**`/key` and `/press` are not the same test.** `/key` puts an event straight on the
queue, so it exercises the UI and would pass even with the key driver completely
broken. `/press` reconfigures the pin as an output, pulls it to ground and lets go —
electrically what the switch does — so it goes through the GPIO interrupt, the
debounce and the queue. After changing anything below the UI, `/press` is the one
that means something.

**Opening the port resets the chip**, so the device you are asking is one that booted a
second ago. A `/screen` read right after connecting says `boot` and looks like a hang; the
websocket does not report `linked` until ~5.9 s, and only then does the panel reach the
dashboard. Drain for six seconds or more before believing what the screen says, and read
the boot log rather than guessing — `dtr = rts = False` does not prevent this on
USB-Serial-JTAG.

It is **intermittent**, which is worse than reliable. Two runs minutes apart: the first
opened the port without resetting, and notifications posted five minutes earlier were still
in the ring; the next printed a full boot log from `octal_psram` onward. So assume neither —
look for the boot banner in what you drained and decide from that. Anything held in RAM,
the notification ring included, is gone if it did reset.

`/screen` is what makes a claim checkable. "Back dismisses the notice" became a fact
only when `/key back` was pressed 1.6 s after the stop and `/screen` reported
`dashboard` rather than `launcher` — an earlier test pressed it after the 4 s notice
had already cleared itself and proved nothing. **Time the assertion against the
timeout you are testing.** And read the screen back rather than assuming where you
are: a navigation script that starts from the wrong screen aims every later press at
the wrong thing and the failure looks like a bug in the feature.

## Settled by measurement — do not "improve" these

Each of these looks like a conservative default and is not. Changing one back reintroduces
a bug that took a while to find.

- **The panel runs at 20 MHz.** 40 and 26.67 MHz were both tried on this glass and both
  corrupted the picture. A full 240×240 flush is ~46 ms, so ~15 fps is the ceiling and the
  video target of 12 is deliberate.
- **The d-pad pins are 42/41/40/39, not 39/40/41/42.** Wired in the labelled order the axes
  came out swapped. Diagnostics → key test shows the truth.
- **Flow control is a *grant*, not a level.** `video.ready` / `note.ready` say how much has
  just been freed. Reporting free space is racy — bytes in flight are not yet in the ring —
  and that bug cost half the frames.
- **The media frame header has a pad byte.** Without it PCM starts on an odd address and an
  unaligned 16-bit load on Xtensa returns rubbish, which sounds like distortion rather than
  a crash.
- **Audio is the master clock.** Late video frames are dropped; sound is never stalled to
  wait for a frame.
- **JPEG must be baseline.** The on-device decoder silently rejects progressive.
- **`-ss` goes before `-i`** in the ffmpeg args — after it, ffmpeg decodes up to the seek
  point instead of using the index.
- **Kill ffmpeg with `taskkill /T /F`.** `ffmpeg` on PATH here is a Chocolatey shim;
  killing the shim orphans the real process, which keeps the file open. The symptom was
  "File ended prematurely", which points nowhere near the cause.
- **Truncate strings by code point, not by `slice`.** Cutting a flag emoji's surrogate pair
  made PostgREST reject the entire request (`PGRST102`). There is also a boundary scrub in
  `src/lib/db/tool-calls.ts`.
- **Nothing is scheduled until real time arrives.** `sched_init()` runs before wifi, so on a
  cold boot the clock reads 1970; a daily alarm scheduled then is overdue the instant SNTP
  lands and rings immediately. All scheduling happens in the tick's jump detection instead,
  and the tick that discovers the jump fires nothing.
- **`notes_play()` copies the id before doing anything.** Seeking calls it with
  `notes_current()`, which points at the very field `notes_stop()` clears.
- **Light sleep kills the USB-Serial-JTAG console, and IDF's option for that does not
  save you.** `CONFIG_USJ_NO_AUTO_LS_ON_CONNECTION` is supposed to hold a
  `NO_LIGHT_SLEEP` lock while a USB host is attached, and it is enabled — but the
  detection is a FreeRTOS tick hook looking for a USB SOF packet every tick, and
  under tickless idle the ticks it needs stop arriving. So it drops the lock, the
  chip sleeps, and the console dies while wifi and the websocket carry on perfectly.
  Worse, **the chip then will not answer download mode either**, so `idf.py flash`
  fails with "No serial data received" and recovery needs BOOT held while resetting.
  That is why `power_save` is a setting and defaults to **off**.
- **The I2S driver's power lock is taken in `i2s_channel_enable`, not at channel
  creation.** So leaving the channels configured at boot costs nothing, and there is
  no reason to create and destroy them around every use. `/power` shows both
  `i2s_driver` locks at zero while idle.
- **The mic button has to stop a ringing alarm explicitly.** The ring screen is modal and
  any key dismisses it, but the push-to-talk button is not a key — it goes through
  `bsp_button`, not the key queue, so pressing it opened a recording whose screen covered
  the ring screen while the alarm task happily sounded for its full minute. The alarm
  looked dismissed and was not. `on_talk_press` now injects a key instead of reaching
  into the screen stack from the button task, so `ringing` and the stack are still
  cleared together in one place, and the release is suppressed so the press is not also
  counted as the tap that starts a voice note.
- **A `wifi_ap_record_t[24]` does not fit on the event loop task's stack.** The scan
  result buffer must be static; on the stack it overflows `sys_evt` and panics.

## The server

Read `ai-server/README.md` first. Things that bite:

- It is usually run as a **production build** (`pnpm start`), so a source change is invisible
  until `pnpm build` and a restart. A stale process 404s routes that exist on disk.
- **Supabase migrations are applied by hand** by the owner in the SQL editor. There is no
  runner. New columns need an explicit "please run `supabase/migrations/NNNN_*.sql`".
- **ffmpeg is not in the Railway build** (`railway.json` uses RAILPACK with no `nixpacks.toml`
  or `Dockerfile`), so every server-side video source works in dev and fails in production.
  The same trap applies to any host's plain Node runtime; the Docker option in
  [ai-server/DEPLOY-RENDER.md](ai-server/DEPLOY-RENDER.md) is the way round it.
- **The server cannot be scaled past one instance.** `live`, `bus` and the peer registries
  are `globalThis` singletons holding the device sockets, so a second replica would report
  a connected device as offline for half of all requests. Moving that state out is a
  project, not a config change.
- **A peer has no presence, and `devices.status` lies about it.** Nothing connects for a
  kind-`agent` row — the server calls it — so its `status` column stays `"offline"` for
  ever. Five separate views rendered that column and so dressed a working harness as a
  fault: the devices list, the dashboard strip and its "nodes online" stat, the sidebar
  ratio, the command palette and the settings list. The fix is `src/lib/fleet-view.ts`:
  `fleetState(device, peer?)` returns the label, tone and whether to light up, and
  `peerInfoFor(devices)` in `db/agents.ts` loads the reachability it needs from the cache
  only. **Any new view that lists devices must go through those two**, or it reintroduces
  this. Note "unchecked" is a real third state — the probe is cached and may not have run
  yet — and is not a quiet "unreachable".

  An attached agent **does** count as a node in the sidebar ratio and the dashboard stat;
  "up" just means reachable for one rather than connected. Excluding them was tried and
  the owner rejected it. The cache is warmed once in `attachGateway`, because every
  request path reads it without probing and the sidebar lives in a layout that does not
  re-render on client navigation — without that warm-up a peer stays "not checked yet"
  until a full reload.

- **A route an outside system posts to has to be added to the proxy's matcher**
  (`src/proxy.ts`). Everything under `/api/` 401s on the admin session cookie before the
  handler runs, so the symptom of forgetting is a route that looks missing. `/ws` and
  `/api/peers` are the two exclusions, and both authenticate themselves instead.

One agent, not two: the console page and each device's live session get the same fleet tools
(`src/agent/master.ts`), so you can stand at the terminal and act on another machine. A
device's agent is told which roster line is its own and refuses to target itself.

**Not every roster line is a machine.** A device of kind `agent` is an attached harness —
OpenClaw, NanoClaw, Hermes — reached over HTTP instead of over `/ws`: the server calls its
OpenAI-compatible `/v1/chat/completions`, which OpenClaw and Hermes both speak, so one
client covers them. **NanoClaw does not speak it** — it has no HTTP surface at all, only
messaging-app channels and SQLite between its own processes — so the endpoint is supplied
by a channel adapter written into the NanoClaw checkout (`src/channels/aiterm.ts` in
`E:\programming\nanoclaw`). Nothing on the server side knows the difference, and that is
the point: do not "simplify" `peers.ts` toward one harness's quirks.
`ask_device` reaches one. `call_device_tool` cannot, because a harness has no tool list,
and both it and `device_tools` have to turn a peer away *before* `onlineLink`, which would
otherwise report the misleading "is offline".

They are slow, so a task unanswered after **60 s** is handed off: the tool returns a job
id, the request keeps running, and the answer arrives later as a `notice` — which the
firmware already turns into a notification, so this needed no firmware change at all.
`agent_job(id)` reads the full text. One task at a time per peer.

A peer can also be asked directly from its own device page: the live tab becomes **asks**,
and the composer posts to `/api/devices/[id]/prompt`, which branches on
`kind === "agent"` and goes through the same `peer-jobs.start` — so the handoff, the busy
guard and the `tool_calls` row behave identically whether the ask came from the dashboard
or from another agent's `ask_device`. Those asks reuse the peer's latest session, because
`tool_calls` is FK'd to one.

The other half — the peer speaking first — is `POST /api/peers/inbox` with the agent
device's own token. The detail is in
[ai-server/README.md](ai-server/README.md#attached-agents--openclaw-nanoclaw-hermes), and
the NanoClaw side in `nanoclaw/docs/aiterm-channel.md` (that second repo, not this one).

## Secrets and files that must not be committed

The root is **not** a git repository today. If one is ever created, these must be ignored:

- `main/wifi_credentials.h` — SSID, wifi password, and the device token. The network
  in here is only a **seed** now: on the first boot with an empty store it becomes
  saved network 0, and after that `components/proto/wifi_store.c` is the source of
  truth. Changing the header on a device that has already booted does nothing.
- `ai-server/.env.local` — `GROQ_API_KEY`, `DEEPSEEK_API_KEY`, `TAVILY_API_KEY`,
  `SUPABASE_SECRET_KEY`, `ADMIN_USERNAME` / `ADMIN_PASSWORD`, `SESSION_SECRET`.
- `ai-server/yt-dlp.exe` — 17.8 MB binary, already in `ai-server/.gitignore`.

`main/config.h` is deliberately shareable: the server URL lives there, the token does not.
The server IP (`AITERM_SERVER_URI`) is a laptop on DHCP and changes; when the device cannot
connect, check that first.

## Where things stand

Working and exercised on the hardware: the shell and launcher, settings in NVS, the
dashboard, clock/timer/alarm/stopwatch/pomodoro, voice notes (record, list, play, seek),
the agent terminal with push-to-talk, video with sound, images, the tone bank, web search,
notifications with a drawer on DOWN from the dashboard, todos on RIGHT from it (daily
and the rest, right again crosses between them), saved wifi networks with a character
picker for the password, and agent memories at two scopes.

**Attached agents work end to end**, verified on the hardware rather than reasoned about.
`0007_agent_peers.sql` is applied; a device named `nanoclaw` of kind `agent` points at the
NanoClaw in `E:\programming\nanoclaw` (`npm start`, the `aiterm` channel on `:18790`),
which runs on **DeepSeek** via its Anthropic-compatible API. Typed at the terminal, "ask
the nanoclaw agent to run `uname -sm` in its sandbox" came back on the panel as
`nanoclaw printed exactly: Linux x86_64` in 19.8 s, leaving an `ask_agent` row on the peer
(`risk=exec`, `decided_by=server`, `asked_by` the board) — the device's agent rewrote the
prompt into a self-contained task on its own, which is what the tool description asks for.
The talk-back half is proven too: `/api/peers/inbox` → `delivered:true` took the unread
count from 1/1 to 2/2, popped a `notice`, and DOWN opened the drawer with the backlight
waking 0% → 45%. `ai-server/scripts/nanoclawcheck.ts` re-checks the wire (probe, wrong key,
dead port, a `/v1` that must not double); `scripts/attach-nanoclaw.ts` registers it.

The dashboard side is done with it too: a peer's page shows reachability instead of
presence, glows when the harness answers, and its live tab is a working composer — asking
`nanoclaw` something from the browser was the owner's own acceptance test. All of that was
checked by reading the rendered HTML, not by assertion; the how is in the memory note on
verifying the dashboard.

The navigation keys and the talk button are **interrupt driven**: the task blocks on a
notification and only samples every 10 ms while something is being pressed. They are
also light-sleep wake sources. The render loop stops composing frames once the panel
is blank, and runs at 5 Hz instead of 15 just to notice a key.

Open, in rough order of how much it matters:

1. **The appearance of every screen is unverified.** The dashboard, both clock faces, the
   app layouts, the notification drawer, the wifi pages and the character picker have only
   ever been checked as "renders without faulting", and for the picker that matters more
   than usual — forty cells on a 240 px panel is tight. Nobody in the loop can see the
   panel; the owner has to look.
2. **Power saving has never been measured.** The machinery is there and gated behind the
   `power_save` setting, off by default — confirmed on the hardware with `/power`:
   "power saving off; pinned at 240 MHz, no sleep", `usb_serial_jtag NO_LIGHT_SLEEP` held,
   both `i2s_driver` locks at 0. Judging whether it *helps* means unplugging the cable,
   turning it on, and timing a battery — and with the cable out there is no console, so
   there is no other way.
3. **Reaching a harness over Tailscale is untested.** Everything so far is loopback, and
   the remote case is the whole point of the base-url design — `AITERM_BIND=0.0.0.0` and
   the bearer key are already set up for it, but nothing has crossed a tailnet yet.

   While here: running NanoClaw and the server together is tight on this machine (see the
   memory note on build constraints). Docker Desktop's VM plus a warm agent container —
   NanoClaw keeps one alive for `IDLE_TIMEOUT`, 30 min, so follow-ups reuse it — can leave
   under 1 GB free, and `docker stop` on an idle `nanoclaw-aiterm-*` is the cheap fix.
   **But do not read a dead server as an out-of-memory kill.** The background-job wrapper
   reports `exit 127` and the child `4294967295` for *any* external termination, so that
   signature cannot tell memory pressure from the owner pressing Ctrl-C; it was diagnosed
   as memory twice on 2026-10-02 and was the owner both times. Check what is actually
   listening, then ask.
4. **ffmpeg on Railway** (above), and the Render deployment in
   [ai-server/DEPLOY-RENDER.md](ai-server/DEPLOY-RENDER.md) is written but has never been
   run — the attached agent's base url in particular has to change for it.
5. **No second wifi network has been tried.** There is only one here, so "scan and move to
   another saved network when the link drops" is built and reviewed but not exercised.
6. The Phase 0 bench (`bench.cpp`, three embedded JPEGs, `/bench`, `/soak`) is still in the
   tree and could go.

## Working agreements

- **Reproduce before fixing.** The ffmpeg shim, the surrogate-pair truncation, the 1970
  alarm and the recorder-semaphore race were all found by measuring. Every one of them would
  have been misdiagnosed from the symptom.
- **Verify on the device before reporting.** `/key`, `/tap` and `/screen` exist precisely so
  that "should work" never has to be said.
- **Do not write anything containing a backslash through a bash heredoc.** Escapes are
  silently mangled even with a quoted delimiter — `\n` becomes a real newline, `'\0'` has
  become a literal NUL byte in a C file, and a Windows path in Markdown prose came out as
  `E:\programming` + a newline + `anoclaw\docs` with a BEL byte where `\a` had been. It is
  not a C problem, it is a backslash problem, and this very file was the last victim. Use
  the Write or Edit tool, and check afterwards with
  `python -c "import io;d=io.open(f,'rb').read();print(d.count(b'\x07'),d.count(b'\x00'))"`.
- **Check a claim about the SoC in the IDF source or with `/power`, not by reasoning about
  it.** Two confident claims about power management in the plan for this work were wrong in
  opposite directions: the I2S channels were said to pin the clock and do not, and IDF's
  USB-console option was said to make light sleep safe and does not. One of those cost a
  device that had to be recovered with the BOOT button.
- **Comments say why, not what.** The existing ones record measurements and dead ends; match
  that. A comment that restates the line above it is noise.
- The owner reports several things at once in one short message. Treat each as its own item
  and finish all of them.
