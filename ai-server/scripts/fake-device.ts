// Pretends to be an ESP32 terminal speaking protocol v0.
//   pnpm fake-device <token> [ws://localhost:3000/ws] [--quiet] [--no-chat]
import WebSocket from "ws";

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith("--")));
const [token, url = "ws://localhost:3000/ws"] = args;

if (!token) {
  console.error("usage: pnpm fake-device <token> [ws-url] [--quiet] [--no-chat]");
  process.exit(1);
}

const PROMPTS = [
  "what time is it?",
  "give me a one line status report",
  "suggest a name for a tiny robot",
  "what's 17% of 240?",
  "say something encouraging",
];
const LOGS: [string, string][] = [
  ["info", "wifi rssi -58 dBm"],
  ["debug", "heap free 211 KB"],
  ["info", "display: page → home"],
  ["warn", "wifi rssi -81 dBm"],
  ["info", "button B pressed"],
];

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const amber = (s: string) => `\x1b[33m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

// Two harmless pretend tools so the agent flow can be tried without the Python client.
const TOOLS = [
  {
    name: "read_sensor",
    description: "Read a simulated sensor on the terminal (temperature, humidity or light).",
    parameters: { type: "object", properties: { sensor: { type: "string", enum: ["temperature", "humidity", "light"] } }, required: ["sensor"] },
    risk: "read",
  },
  {
    name: "set_led",
    description: "Set the terminal's status LED colour. Needs the user's approval.",
    parameters: { type: "object", properties: { color: { type: "string" } }, required: ["color"] },
    risk: "modify",
  },
];
const approvals = new Map<string, (approved: boolean) => void>();

let backoff = 500;
let sessionId: string | undefined;
let timers: NodeJS.Timeout[] = [];

let current: WebSocket | undefined;

async function runTool(msg: { call_id: string; name: string; args: Record<string, unknown> }) {
  const reply = (frame: object) => current?.send(JSON.stringify(frame));
  console.log(dim(`\n  ⚙ ${msg.name} ${JSON.stringify(msg.args)}`));
  if (msg.name === "read_sensor") {
    const values: Record<string, string> = { temperature: "23.4 °C", humidity: "48 %", light: "310 lux" };
    return reply({ type: "tool.result", call_id: msg.call_id, ok: true, output: values[String(msg.args.sensor)] ?? "unknown sensor", decided_by: "policy" });
  }
  if (msg.name === "set_led") {
    reply({ type: "tool.pending", call_id: msg.call_id, reason: "changes the device's LED" });
    console.log(amber("  waiting for approval from the dashboard…"));
    const approved = await new Promise<boolean>((resolve) => {
      approvals.set(msg.call_id, resolve);
      setTimeout(() => resolve(false), 120_000);
    });
    approvals.delete(msg.call_id);
    if (!approved) return reply({ type: "tool.result", call_id: msg.call_id, ok: false, denied: true, error: "denied by the user", decided_by: "web" });
    console.log(green(`  LED → ${msg.args.color}`));
    return reply({ type: "tool.result", call_id: msg.call_id, ok: true, output: `LED is now ${msg.args.color}`, decided_by: "web" });
  }
  reply({ type: "tool.result", call_id: msg.call_id, ok: false, denied: true, error: "unknown tool", decided_by: "policy" });
}

function connect() {
  console.log(dim(`→ connecting to ${url}`));
  const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
  current = ws;
  let chatting = false;

  const send = (msg: object) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg));

  ws.on("unexpected-response", (_req, res) => {
    console.error(red(`✕ rejected: HTTP ${res.statusCode}${res.statusCode === 401 ? " (bad token?)" : ""}`));
    if (res.statusCode === 401) process.exit(1);
  });

  ws.on("open", () => {
    backoff = 500;
    console.log(green("✓ connected"));
    send({
      type: "hello",
      protocol: 1,
      fw: "0.1.0-sim",
      hw: "ESP32-S3 N16R8 (simulated)",
      capabilities: ["chat", "display", "buttons", "tools"],
      tools: TOOLS,
      access: { level: "standard", remote_approval: true },
    });

    timers.push(
      setInterval(() => {
        const [level, msg] = LOGS[Math.floor(Math.random() * LOGS.length)];
        send({ type: "log", level, msg });
      }, 4000 + Math.random() * 4000),
      setInterval(() => {
        send({ type: "event", event: Math.random() < 0.5 ? "command" : "action", summary: Math.random() < 0.5 ? "button A → assistant" : "display.page → weather" });
      }, 9000 + Math.random() * 6000),
    );

    if (!flags.has("--no-chat")) {
      const chat = () => {
        if (chatting) return;
        chatting = true;
        const text = PROMPTS[Math.floor(Math.random() * PROMPTS.length)];
        console.log(`\n${amber("you  ›")} ${text}`);
        process.stdout.write(`${green("term ›")} `);
        send({ type: "chat", text, session_id: sessionId });
      };
      timers.push(setTimeout(chat, 2500), setInterval(chat, 30000));
    }
  });

  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    switch (msg.type) {
      case "chat.user":
        console.log(`\n${amber("web  ›")} ${msg.text}`);
        process.stdout.write(`${green("term ›")} `);
        break;
      case "tool.call":
        void runTool(msg);
        break;
      case "tool.approve": {
        const waiter = approvals.get(msg.call_id);
        if (waiter) waiter(Boolean(msg.approved));
        break;
      }
      case "session":
        sessionId = msg.session_id ?? undefined;
        console.log(dim("\n  [new session]"));
        break;
      case "welcome":
        console.log(dim(`  welcome: ${msg.name} (${msg.device_id.slice(0, 8)}) protocol v${msg.protocol} config=${JSON.stringify(msg.config)}`));
        break;
      case "config":
        console.log(amber(`\n⟳ config pushed: ${JSON.stringify(msg.config)}`));
        break;
      case "chat.delta":
        sessionId = msg.session_id;
        process.stdout.write(msg.text);
        break;
      case "chat.done":
        chatting = false;
        console.log(dim(`\n  [${msg.usage.input} in / ${msg.usage.output} out tokens]`));
        break;
      case "error":
        chatting = false;
        console.log(red(`\n!! ${msg.msg}`));
        break;
      default:
        if (!flags.has("--quiet")) console.log(dim(`  ${raw}`));
    }
  });

  ws.on("close", (code, reason) => {
    timers.forEach(clearTimeout);
    timers = [];
    console.log(red(`✕ closed ${code} ${reason}`), dim(`retry in ${backoff}ms`));
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 30_000);
  });

  ws.on("error", (err) => console.error(red(`!! ${err.message}`)));
}

process.on("SIGINT", () => {
  console.log(dim("\nbye"));
  process.exit(0);
});

connect();
