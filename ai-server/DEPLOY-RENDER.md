# Deploying the server on Render

The thing being deployed is `ai-server/`: the dashboard, the agent, and the `/ws` gateway
the ESP32 connects to — one process, one port. It is a **custom Node server**
(`server.ts` mounts Next.js and the WebSocket gateway on the same HTTP server), not a
static site and not a serverless function, so on Render it is a single **Web Service**.

Read this whole page before starting. Two of the steps cannot be undone comfortably:
committing secrets, and losing the ability to reach the attached agent.

---

## 0. One constraint that shapes everything: exactly one instance

The gateway keeps its live state **in process**, on `globalThis` — `__aitermLinks`
(which device socket is connected), `__aitermBus` (the dashboard's SSE fan-out),
`__aitermPeerHealth` and `__aitermPeerJobs`. A device's websocket lands on one instance;
a dashboard request that wants to act on that device must land on the *same* one.

So **do not scale this past one instance.** With two, roughly half of every request would
report a connected device as offline. If it ever needs to scale, that state has to move to
Redis or Postgres first — it is not a config change.

Set the instance count to 1 and leave autoscaling off.

---

## 1. Before anything: a git repository that does not leak

The project root is **not** a git repository today, and three files must never be
committed. Write the ignores *before* the first `git add`, because a secret in history is
not removed by deleting the file later.

```bash
cd E:\programming\esp32-ai-term
git init
```

Then a root `.gitignore` containing at least:

```gitignore
# secrets
main/wifi_credentials.h     # wifi SSID + password + the device token
ai-server/.env.local        # Supabase service key, admin password, all the model keys

# build output and a 17 MB Windows binary
build/
ai-server/.next/
ai-server/node_modules/
ai-server/yt-dlp.exe
managed_components/
sdkconfig.old
```

Verify before committing:

```bash
git add -A
git status --porcelain | grep -E "wifi_credentials|\.env\.local|yt-dlp"   # must print nothing
```

Render deploys from GitHub/GitLab, so push this to a **private** repository.

---

## 2. Run the Supabase migrations first

There is no migration runner in this repo; they are applied by hand in the Supabase SQL
editor. Run every file in `supabase/migrations/` in order, `0001` through `0007`, against
the project you are going to point Render at. A server that boots against a database
missing `0007_agent_peers.sql` cannot register an attached agent at all, and the failure
reads as a check-constraint violation rather than as a missing migration.

You can keep using the same Supabase project the laptop uses — nothing in the schema is
per-host.

---

## 3. Pick a runtime: Node or Docker

The difference is **ffmpeg**, and it is worth understanding before choosing.

| | Native Node | Docker |
| --- | --- | --- |
| dashboard, agent, tools, `/ws`, voice notes, notifications | work | work |
| transcription, web search, memories, attached agents | work | work |
| **server-side video and YouTube** | **fail** | work |
| build time | faster | slower |

`src/lib/video/ffmpeg.ts` spawns `ffmpeg` and `yt-dlp` as processes. Render's native Node
runtime has neither, so every video source fails there — the same way it fails on Railway
today, which is a known open item in `AGENTS.md`. Everything else is pure Node and is
unaffected.

Choose **native Node** if you do not care about video from the server. Choose **Docker** if
you do.

### 3a. Native Node

Create a Web Service from the repo and set:

| field | value |
| --- | --- |
| Root Directory | `ai-server` |
| Runtime | Node |
| Build Command | `corepack enable && pnpm install --frozen-lockfile && pnpm build` |
| Start Command | `pnpm start` |
| Health Check Path | `/api/health` |
| Instances | 1 |

`corepack enable` matters: `package.json` pins `pnpm@10.14.0` through `packageManager`,
and without corepack the build uses whatever pnpm the image happens to have.

**Do not set `NODE_ENV=production` as an environment variable.** `next build` needs
`typescript`, which is a devDependency; with `NODE_ENV=production` the install skips
devDependencies and the build fails. Render already runs the service in production mode
without it. (`tsx`, which `pnpm start` needs, *is* a real dependency, so that part is safe
either way.)

### 3b. Docker, with ffmpeg

Add `ai-server/Dockerfile`:

```dockerfile
FROM node:22-slim

# ffmpeg is the whole reason for this image. ca-certificates is needed to fetch yt-dlp.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# yt-dlp next to the server: resolveYtDlp() checks ./yt-dlp before falling back to PATH.
# The _linux build is self-contained, so no Python is needed in the image.
RUN curl -fsSL -o /app/yt-dlp \
      https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux \
    && chmod +x /app/yt-dlp

RUN corepack enable

# Dependencies first, so a source-only change does not reinstall them.
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

# Render injects PORT; server.ts reads it and falls back to 3000.
EXPOSE 3000
CMD ["pnpm", "start"]
```

and `ai-server/.dockerignore`:

```
node_modules
.next
.env.local
yt-dlp.exe
```

`yt-dlp.exe` is excluded deliberately — it is the Windows build, and `resolveYtDlp()`
checks for `yt-dlp.exe` *before* `yt-dlp`, so copying it in would shadow the Linux binary
with something that cannot run.

Then set the service's Root Directory to `ai-server`, Runtime to Docker, Health Check Path
to `/api/health`, and instances to 1.

---

## 4. Environment variables

Only two are genuinely required — the server throws on boot without them
(`src/lib/env.ts`):

| variable | required | note |
| --- | --- | --- |
| `SUPABASE_URL` | **yes** | must be a valid URL |
| `SUPABASE_SECRET_KEY` | **yes** | the service-role key; it bypasses RLS, so treat it as root |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD` | in practice yes | the dashboard login; read by `auth.ts`, not by the env schema |
| `SESSION_SECRET` | in practice yes | signs the session cookie. Generate a fresh one, do not reuse the laptop's |
| `APP_URL` | recommended | set to `https://<service>.onrender.com`; defaults to localhost |
| `DEFAULT_MODEL` | optional | defaults to `deepseek:deepseek-v4-flash` |
| `DEEPSEEK_API_KEY` / `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GOOGLE_GENERATIVE_AI_API_KEY` | optional | whichever provider `DEFAULT_MODEL` names |
| `GROQ_API_KEY` | optional | transcription; without it push-to-talk has nothing to transcribe with |
| `TRANSCRIBE_MODEL` | optional | defaults to `whisper-large-v3-turbo` |
| `TAVILY_API_KEY`, `SERPER_API_KEY` | optional | web search |
| `PORT` | **do not set** | Render provides it |
| `NODE_ENV` | **do not set** | see 3a |

Note that blank values are treated as unset, so an empty box is the same as no box.

---

## 5. Point the device at it

Render terminates TLS and serves HTTPS only, so the device needs `wss://`. The firmware
already handles that — `aiterm_ws.c` attaches the ESP-IDF certificate bundle whenever the
URI starts with `wss://`, so no certificate has to be embedded.

Edit `main/config.h`:

```c
#define AITERM_SERVER_URI "wss://<your-service>.onrender.com/ws"
```

then rebuild and flash:

```powershell
. C:\Espressif\tools\Microsoft.v6.1.PowerShell_profile.ps1
idf.py build
idf.py -p COM10 flash
```

The device token stays in `main/wifi_credentials.h` and does not change. The device must
already exist in **Settings → devices** on the deployed server with that token's hash — if
you are using the same Supabase project, it already does.

Confirm over the cable rather than guessing: `/screen` should reach `dashboard`, and the
boot log should show `app: linked to the AI-TERM server` within about six seconds. Opening
COM10 can reset the chip, so drain the port for ten seconds before believing what it says.

---

## 6. What this does to the attached agent

This is the step most likely to surprise you. The `nanoclaw` peer is configured with
`base_url = http://127.0.0.1:18790`, which on Render means *the Render container itself* —
where nothing is listening. The peer will read `unreachable` the moment you cut over.

Three ways out, in order of how much they cost:

1. **Tailscale Funnel on the harness.** Expose `:18790` at a public `https://…ts.net`
   address and set that as the base url. The `AITERM_API_KEY` bearer check is what keeps it
   private, and the harness already binds `0.0.0.0` for this. Simplest, and the design was
   built for it.
2. **Tailscale inside the container.** Add `tailscaled` to the Dockerfile and a
   `TS_AUTHKEY`, then keep using the tailnet name. More moving parts, and the daemon has to
   come up before the first probe.
3. **Leave the agent attached to the laptop's server** and run Render only for the device
   and the dashboard. Nothing breaks; the peer simply lives elsewhere.

Whichever you pick, the inbox side needs updating too: `AITERM_INBOX_URL` in
`nanoclaw/.env` currently points at `http://127.0.0.1:3000/api/peers/inbox` and must become
the Render URL, or the harness's unprompted messages go nowhere.

None of this has been exercised yet — reaching a harness over Tailscale is an open item,
and this is the deployment that forces it.

---

## 7. Caveats worth knowing before you rely on it

- **The free tier spins down when idle.** The device's websocket dies with it, and although
  the firmware reconnects on its own, everything held in process is gone: a handed-off peer
  job loses its answer, and `tool_calls` rows for it are left `running`. A terminal that is
  supposed to stay linked wants a paid instance that does not sleep.
- **Every deploy is a restart**, with the same consequences. `markAllOffline()` runs at
  boot, so devices show offline for the few seconds until they reconnect.
- **The peer health cache is warmed once at boot**, so right after a deploy an attached
  agent reads `not checked yet` until the first probe lands.
- **Nothing is stored on disk.** Audio clips, notes and video frames are streamed or kept in
  Supabase. Render's filesystem is ephemeral, which is fine here — but do not add anything
  that writes files and expects them later.
- **`/api/peers/inbox` and `/ws` authenticate themselves** with bearer tokens and are
  excluded from the admin-cookie proxy (`src/proxy.ts`). That is what makes them reachable
  from outside, and it is also why their tokens are as sensitive as the admin password.

---

## 8. Optional: a blueprint instead of the dashboard

`ai-server/render.yaml`, if you would rather not click through the form. Secrets stay
`sync: false` so Render prompts for them instead of storing them in git.

```yaml
services:
  - type: web
    name: aiterm-server
    runtime: docker          # or: node, with buildCommand/startCommand from 3a
    rootDir: ai-server
    dockerfilePath: ./Dockerfile
    plan: starter            # free sleeps; see the caveats
    healthCheckPath: /api/health
    numInstances: 1
    envVars:
      - key: SUPABASE_URL
        sync: false
      - key: SUPABASE_SECRET_KEY
        sync: false
      - key: ADMIN_USERNAME
        sync: false
      - key: ADMIN_PASSWORD
        sync: false
      - key: SESSION_SECRET
        generateValue: true
      - key: DEEPSEEK_API_KEY
        sync: false
      - key: GROQ_API_KEY
        sync: false
      - key: APP_URL
        value: https://aiterm-server.onrender.com
```

---

## 9. Checking it actually works

In this order, because each one rules out a different failure:

```bash
curl https://<service>.onrender.com/api/health
# {"ok":true,"uptime":…,"devices_connected":0}

curl -i https://<service>.onrender.com/api/fleet
# 401 — the admin proxy is doing its job

curl -i -XPOST https://<service>.onrender.com/api/peers/inbox
# {"error":"no token"} and NOT the proxy's "unauthorized":
# anything else means the proxy matcher is wrong for this deploy
```

Then log in to the dashboard, and only then flash the device. If the device does not
appear, check in this order: the `wss://` scheme in `config.h`, that the token's device row
exists on *this* Supabase project, and the Render logs for a rejected upgrade.
