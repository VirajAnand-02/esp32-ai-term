import type { AgentPeer } from "./types";

// Talking to an attached agent harness.
//
// OpenClaw, NanoClaw and Hermes are different projects that all landed on the same
// front door: an OpenAI-compatible `POST /v1/chat/completions` behind a bearer token
// (OpenClaw on :18789, Hermes on :8642 behind API_SERVER_KEY, NanoClaw likewise). So
// this is one client rather than three integrations, and a fourth harness later is a
// row in `agent_peers` rather than a code change.
//
// Each call is self-contained. The endpoint is stateless -- the whole conversation is
// supposed to be resent every time -- and we deliberately send only the task, so the
// harness starts fresh and its own memory does the remembering. Threading belongs on
// Hermes's `/v1/responses` with `previous_response_id`, not in a transcript we keep.

const PROBE_MS = 3_000;
// A health reading older than this is not evidence any more, so the roster says
// "unknown" rather than quoting it.
const FRESH_MS = 5 * 60_000;
const ERROR_BODY = 300;

export type Reachable = "yes" | "no" | "unknown";

// Same reason as live.ts and bus.ts: the gateway and the Next route handlers are
// separate module graphs in one process, so shared state hangs off globalThis.
const g = globalThis as { __aitermPeerHealth?: Map<string, { ok: boolean; at: number }> };
const health = (g.__aitermPeerHealth ??= new Map());

// A peer's url may be given with or without the /v1 prefix; both are what people
// paste out of the harness's own docs.
function endpoint(baseUrl: string, path: string): string {
  const base = baseUrl.trim().replace(/\/+$/, "");
  return /\/v1$/.test(base) ? `${base}${path}` : `${base}/v1${path}`;
}

function headers(peer: AgentPeer): HeadersInit {
  return {
    "content-type": "application/json",
    ...(peer.api_key ? { authorization: `Bearer ${peer.api_key}` } : {}),
  };
}

// The harnesses return real diagnostics -- a wrong key says so, a disabled API server
// says so -- and losing them to a generic "request failed" is how an afternoon goes.
async function detail(res: Response): Promise<string> {
  const body = await res.text().catch(() => "");
  return `${res.status}: ${body.slice(0, ERROR_BODY).trim() || res.statusText}`;
}

// Content is a string in the spec, but a harness that proxies a Claude model may hand
// back the content-part array instead.
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : ((part as { text?: string })?.text ?? "")))
      .join("");
  }
  return "";
}

/** Hands one self-contained task to a harness and returns its answer. */
export async function askPeer(peer: AgentPeer, task: string, signal?: AbortSignal): Promise<string> {
  // fetch has no timeout of its own, and nothing above a background job caps it.
  const timeout = AbortSignal.timeout(Math.max(10, peer.timeout_s) * 1000);
  const res = await fetch(endpoint(peer.base_url, "/chat/completions"), {
    method: "POST",
    headers: headers(peer),
    body: JSON.stringify({
      // Harnesses advertise their own profile name as the model and ignore anything
      // else; "default" is what they fall back to when the field means nothing to them.
      model: peer.model?.trim() || "default",
      messages: [{ role: "user", content: task }],
      stream: false,
    }),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  }).catch((err: Error) => {
    // A dead tailnet host, a refused connection and a timeout all arrive here, and
    // "fetch failed" on its own tells the model nothing it can act on.
    mark(peer.device_id, false);
    throw new Error(`could not reach ${peer.base_url}: ${err.name === "TimeoutError" ? "timed out" : err.message}`);
  });

  if (!res.ok) {
    // A 401 means the key is wrong, not that the host is down, so the health reading
    // stays honest: we did reach it.
    mark(peer.device_id, true);
    throw new Error(`the agent answered ${await detail(res)}`);
  }
  mark(peer.device_id, true);

  const data = (await res.json().catch(() => null)) as {
    choices?: { message?: { content?: unknown } }[];
  } | null;
  const answer = textOf(data?.choices?.[0]?.message?.content).trim();
  if (!answer) throw new Error("the agent answered with no text at all");
  return answer;
}

export type Probe = { reachable: boolean; accepted: boolean; detail: string };

/**
 * Is it there? Asking for the model list is the cheapest thing that exercises the whole
 * path at once: the host resolves, something is listening, and the key is accepted.
 *
 * Reachable and accepted are separate answers. A 401 proves the harness is running —
 * which is what the roster reports — while saying the key is wrong, and conflating the
 * two sends you looking at the network when the problem is a token.
 */
export async function probePeer(peer: AgentPeer): Promise<Probe> {
  let res: Response;
  try {
    res = await fetch(endpoint(peer.base_url, "/models"), {
      headers: headers(peer),
      signal: AbortSignal.timeout(PROBE_MS),
    });
  } catch (err) {
    mark(peer.device_id, false);
    const why = (err as Error).name === "TimeoutError" ? "timed out" : (err as Error).message;
    return { reachable: false, accepted: false, detail: `nothing answered: ${why}` };
  }

  mark(peer.device_id, true);
  if (res.ok) {
    return { reachable: true, accepted: true, detail: `answered${peer.api_key ? " and took the key" : " (no key set)"}` };
  }
  if (res.status === 401 || res.status === 403) {
    return { reachable: true, accepted: false, detail: `is running but rejected the key (${await detail(res)})` };
  }
  return { reachable: true, accepted: false, detail: `answered ${await detail(res)}` };
}

function mark(deviceId: string, ok: boolean) {
  health.set(deviceId, { ok, at: Date.now() });
}

/**
 * Never does I/O. `fleetRoster` is awaited inside `instructions()` on every single
 * turn, so a 3 s probe in here would add 3 s to every prompt typed on the panel. Read
 * the cache, and let `refreshStale` fill it for the turn after this one.
 */
export function peerReachable(deviceId: string): Reachable {
  const seen = health.get(deviceId);
  if (!seen || Date.now() - seen.at > FRESH_MS) return "unknown";
  return seen.ok ? "yes" : "no";
}

/** Kicks off probes for anything stale, without waiting for them. */
export function refreshStale(peers: AgentPeer[]): void {
  for (const peer of peers) {
    if (peerReachable(peer.device_id) === "unknown") void probePeer(peer).catch(() => {});
  }
}

/** Forgets a peer's health reading, so the next roster treats it as unchecked. */
export function forgetHealth(deviceId: string): void {
  health.delete(deviceId);
}

/**
 * Just the host. Used wherever a peer's whereabouts is shown rather than called: the
 * roster, so the model can say where an agent lives, and the devices list, which has a
 * one-line slot. Never the full url — on some setups it carries a token in the query.
 */
export function peerHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}
