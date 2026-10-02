// Register the NanoClaw running on this machine as an attached agent.
//
//   pnpm tsx scripts/attach-nanoclaw.ts
//
// Idempotent: reuses the device if a kind-"agent" one by this name already exists, and
// only rotates its token when asked (--rotate), since the token has to be copied into
// nanoclaw/.env by hand and rotating it silently would break the inbox half.
//
// The insert is also the only way to prove 0007's widened devices_kind_check: PostgREST
// rejects kind "agent" with a check violation until that migration has run.
import fs from "fs";
import path from "path";

import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

const NAME = process.env.PEER_NAME ?? "nanoclaw";
const BASE_URL = process.env.NANOCLAW_URL ?? "http://127.0.0.1:18790";
const NANOCLAW_ENV = process.env.NANOCLAW_ENV ?? "E:/programming/nanoclaw/.env";
const ROTATE = process.argv.includes("--rotate");

/** The channel key from nanoclaw's own .env, so the two sides cannot drift. */
function channelKey(): string {
  const text = fs.readFileSync(NANOCLAW_ENV, "utf-8");
  const line = text.split("\n").find((l) => l.trim().startsWith("AITERM_API_KEY="));
  if (!line) throw new Error(`no AITERM_API_KEY in ${NANOCLAW_ENV}`);
  return line.slice(line.indexOf("=") + 1).trim();
}

async function main() {
  const { createDevice, listDevices, rotateDeviceToken } = await import("@/lib/db/devices");
  const { savePeer, getPeer } = await import("@/lib/db/agents");
  const { probePeer } = await import("@/lib/peers");

  const key = channelKey();
  console.log(`channel key read from ${NANOCLAW_ENV} (${key.length} chars)`);

  const existing = (await listDevices()).find((d) => d.name === NAME && d.kind === "agent");
  let deviceId: string;
  let token: string | null = null;

  if (existing) {
    deviceId = existing.id;
    console.log(`ok    reusing device "${NAME}" (${deviceId})`);
    if (ROTATE) {
      token = await rotateDeviceToken(deviceId);
      console.log("ok    token rotated");
    }
  } else {
    // This is the assertion. Without 0007 it throws a devices_kind_check violation.
    const made = await createDevice({ name: NAME, kind: "agent" });
    deviceId = made.device.id;
    token = made.token;
    console.log(`ok    created device "${NAME}" of kind "agent" (${deviceId})`);
    console.log("ok    devices_kind_check accepts \"agent\" — 0007 is applied");
  }

  await savePeer({
    device_id: deviceId,
    base_url: BASE_URL,
    api_key: key,
    model: null, // the harness picks; nanoclaw's .env sets ANTHROPIC_MODEL
    timeout_s: 900,
  });
  const saved = await getPeer(deviceId);
  console.log(`ok    agent_peers row saved — ${saved?.base_url} key=${saved?.api_key ? "set" : "none"} timeout=${saved?.timeout_s}s`);

  const probe = await probePeer(saved!);
  console.log(`${probe.reachable && probe.accepted ? "ok  " : "FAIL"}  probe — ${probe.detail}`);

  if (token) {
    // Written to a file rather than printed, so the token does not sit in a transcript.
    const out = path.join(process.cwd(), ".peer-token");
    fs.writeFileSync(out, token);
    console.log(`\ntoken written to ${out} (starts ${token.slice(0, 6)}…, ${token.length} chars)`);
    console.log("put it in nanoclaw/.env as AITERM_DEVICE_TOKEN, then delete that file");
  } else {
    console.log("\ntoken unchanged — pass --rotate to mint a new one");
  }
  process.exit(0);
}

void main();
