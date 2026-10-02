// Point the server's own peer client at the NanoClaw running on this machine.
// Temporary: delete once it has been run. Needs no migration and writes no rows.
//
//   pnpm tsx scripts/nanoclawcheck.ts

import { askPeer, probePeer } from "@/lib/peers";
import type { AgentPeer } from "@/lib/types";

const BASE_URL = process.env.NANOCLAW_URL ?? "http://127.0.0.1:18790";
const API_KEY = process.env.NANOCLAW_KEY ?? "";

const peer: AgentPeer = {
  device_id: "00000000-0000-0000-0000-00000000c1aw",
  base_url: BASE_URL,
  api_key: API_KEY,
  model: null,
  timeout_s: 120,
};

let failed = 0;
function check(name: string, ok: boolean, detail: string) {
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed++;
}

async function main() {
  console.log(`probing ${BASE_URL}\n`);

  const good = await probePeer(peer);
  check("probePeer reaches it", good.reachable, good.detail);
  check("probePeer says the key was accepted", good.accepted, good.detail);

  const wrongKey = await probePeer({ ...peer, api_key: "nope" });
  check("a wrong key is reachable but not accepted", wrongKey.reachable && !wrongKey.accepted, wrongKey.detail);

  const deadPort = await probePeer({ ...peer, base_url: "http://127.0.0.1:1" });
  check("a dead port is not reachable", !deadPort.reachable, deadPort.detail);

  // The trailing /v1 must not be doubled -- the dashboard will be given either form.
  const withV1 = await probePeer({ ...peer, base_url: `${BASE_URL}/v1` });
  check("a base url ending in /v1 is not doubled", withV1.reachable && withV1.accepted, withV1.detail);

  try {
    const answer = await askPeer(peer, "Reply with exactly: bridge works");
    check("askPeer gets text back", answer.length > 0, JSON.stringify(answer.slice(0, 120)));
  } catch (err) {
    check("askPeer gets text back", false, (err as Error).message);
  }

  try {
    await askPeer({ ...peer, api_key: "nope" }, "hello");
    check("a wrong key surfaces the harness's own 401", false, "it succeeded, which it must not");
  } catch (err) {
    const msg = (err as Error).message;
    check("a wrong key surfaces the harness's own 401", /401|bearer/i.test(msg), msg);
  }

  console.log(`\n${failed === 0 ? "all checks passed" : `${failed} check(s) failed`}`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
