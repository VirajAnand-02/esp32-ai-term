// Fills Supabase with demo devices, events, sessions and memories.
//   pnpm seed           refuses if devices already exist
//   pnpm seed --reset   wipes all app tables first
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

const RESET = process.argv.includes("--reset");

const DEVICES = [
  { name: "ai-term-01", kind: "esp32", hostname: "ai-term", firmware: "0.1.0", hw: "ESP32-S3 N16R8", ip: "192.168.1.42" },
  { name: "kitchen-node", kind: "esp32", hostname: "kitchen", firmware: "0.1.0", hw: "ESP32-S3 N8R2", ip: "192.168.1.57" },
  { name: "garage-sensor", kind: "other", hostname: "garage", firmware: "0.0.9", hw: "ESP32-C3", ip: "192.168.1.63" },
  { name: "laptop-cli", kind: "cli", hostname: null, firmware: "cli 0.1", hw: "node 24", ip: "192.168.1.20" },
] as const;

const CONVERSATIONS: [string, string][][] = [
  [
    ["turn on the desk lamp", "Desk lamp on."],
    ["and dim it to 40%", "Dimmed to 40%."],
  ],
  [["what's the weather tomorrow?", "Light rain in the morning, clearing by noon. High of 18°C."]],
  [
    ["set a timer for 12 minutes", "Timer set: 12 minutes."],
    ["what's it for again?", "You didn't say. Want me to label it?"],
    ["pasta", "Labelled: pasta, 11:58 left."],
  ],
  [["summarise my calendar for today", "Standup at 10, dentist at 3, nothing after 5."]],
  [["how warm is the garage?", "Garage is 14.2°C, humidity 61%."]],
  [["tell me a joke", "My RAM and I have a lot in common: we both forget everything when the power goes out."]],
];

const LOGS = [
  ["info", "wifi rssi -54 dBm"],
  ["info", "display: brightness 80"],
  ["debug", "heap free 213 KB, psram free 7.6 MB"],
  ["warn", "wifi rssi -79 dBm, weak signal"],
  ["info", "mic: wake word detected"],
  ["info", "sntp: time synced"],
  ["error", "i2s: dma buffer underrun"],
  ["info", "button A pressed"],
] as const;

const ACTIONS = ["lamp.desk → on", "timer.set 12m", "display.page → weather", "volume → 60", "scene.evening"];

const MEMORIES = [
  { content: "The user prefers metric units and 24h time.", tags: ["user"] },
  { content: "ai-term-01 sits on the office desk next to the monitor.", tags: ["home", "office"] },
  { content: "Kitchen lights are on the Home Assistant entity light.kitchen_main.", tags: ["home", "kitchen"] },
  { content: "Keep replies under 3 lines: the screen is 320x240.", tags: ["style"] },
];

const pick = <T,>(a: readonly T[]) => a[Math.floor(Math.random() * a.length)];
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

async function main() {
  const { db } = await import("../src/lib/supabase");
  const { hashToken, newDeviceToken } = await import("../src/lib/db/devices");
  const sb = db();

  const { count } = await sb.from("devices").select("*", { count: "exact", head: true });
  if (count && !RESET) {
    console.error(`devices table already has ${count} rows. Run "pnpm seed --reset" to wipe and reseed.`);
    process.exit(1);
  }
  if (RESET) {
    for (const t of ["events", "messages", "sessions", "memories", "devices", "settings"]) {
      const col = t === "settings" ? "key" : "id";
      const { error } = await sb.from(t).delete().not(col, "is", null);
      if (error) throw new Error(`${t}: ${error.message}`);
    }
    console.log("wiped existing data");
  }

  const tokens: { name: string; token: string }[] = [];
  const devices: { id: string; name: string }[] = [];
  for (const d of DEVICES) {
    const token = newDeviceToken();
    const { data, error } = await sb
      .from("devices")
      .insert({ ...d, token_hash: hashToken(token), status: "offline", last_seen_at: minutesAgo(Math.random() * 90), config: { display_brightness: 80, volume: 60 } })
      .select("id, name")
      .single();
    if (error) throw new Error(error.message);
    devices.push(data);
    tokens.push({ name: d.name, token });
  }

  const events: Record<string, unknown>[] = [];
  const models = ["deepseek:deepseek-v4-flash", "deepseek:deepseek-v4-pro", "anthropic:claude-sonnet-5"];

  // ~5 days of background noise.
  for (let i = 0; i < 420; i++) {
    const dev = pick(devices);
    const m = Math.random() ** 1.6 * 60 * 24 * 5;
    const r = Math.random();
    if (r < 0.55) {
      const [level, msg] = pick(LOGS);
      events.push({ device_id: dev.id, type: level === "error" ? "error" : "log", level, summary: msg, created_at: minutesAgo(m) });
    } else if (r < 0.75) {
      events.push({ device_id: dev.id, type: "action", level: "info", summary: pick(ACTIONS), created_at: minutesAgo(m) });
    } else if (r < 0.88) {
      events.push({ device_id: dev.id, type: "command", level: "info", summary: `button → ${pick(["assistant", "mute", "page next", "sleep"])}`, created_at: minutesAgo(m) });
    } else {
      const connect = Math.random() < 0.5;
      events.push({
        device_id: dev.id,
        type: connect ? "connect" : "disconnect",
        level: connect ? "info" : pick(["info", "warn"]),
        summary: connect ? `connected from ${pick(DEVICES).ip}` : "disconnected (1006)",
        created_at: minutesAgo(m),
      });
    }
  }

  // Chat sessions with transcripts.
  for (let i = 0; i < 26; i++) {
    const dev = pick(devices.slice(0, 2).concat(devices[3]));
    const convo = pick(CONVERSATIONS);
    const model = pick(models);
    const start = Math.random() ** 1.4 * 60 * 24 * 6;
    let input = 0;
    let output = 0;
    const { data: session, error } = await sb
      .from("sessions")
      .insert({ device_id: dev.id, title: convo[0][0], model, started_at: minutesAgo(start), ended_at: minutesAgo(start - convo.length) })
      .select("id")
      .single();
    if (error) throw new Error(error.message);

    const messages: Record<string, unknown>[] = [];
    convo.forEach(([q, a], j) => {
      const inTok = 180 + Math.round(Math.random() * 400) + j * 60;
      const outTok = 12 + Math.round(Math.random() * 60);
      input += inTok;
      output += outTok;
      messages.push({ session_id: session.id, device_id: dev.id, role: "user", content: q, tokens: 0, created_at: minutesAgo(start - j) });
      messages.push({ session_id: session.id, device_id: dev.id, role: "assistant", content: a, tokens: outTok, created_at: minutesAgo(start - j - 0.1) });
      events.push({
        device_id: dev.id,
        type: "chat",
        level: "info",
        summary: `“${q}” → ${a}`,
        payload: { session_id: session.id, model, input_tokens: inTok, output_tokens: outTok },
        created_at: minutesAgo(start - j - 0.1),
      });
    });
    await sb.from("messages").insert(messages).throwOnError();
    await sb.from("sessions").update({ input_tokens: input, output_tokens: output }).eq("id", session.id).throwOnError();
  }

  events.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  for (let i = 0; i < events.length; i += 200) {
    await sb.from("events").insert(events.slice(i, i + 200)).throwOnError();
  }

  await sb
    .from("memories")
    .insert(MEMORIES.map((m, i) => ({ ...m, device_id: i === 1 ? devices[0].id : null })))
    .throwOnError();

  console.log(`seeded ${devices.length} devices, ${events.length} events, 26 sessions, ${MEMORIES.length} memories\n`);
  console.log("device tokens (shown once):");
  for (const t of tokens) console.log(`  ${t.name.padEnd(14)} ${t.token}`);
  console.log(`\nsimulate one:  pnpm fake-device ${tokens[0].token}`);
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
