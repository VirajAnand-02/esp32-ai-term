import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { getPeer, listPeers } from "@/lib/db/agents";
import { listDevices } from "@/lib/db/devices";
import { logEvent, listEvents } from "@/lib/db/events";
import { live } from "@/lib/live";
import { calendarAvailable } from "@/lib/calendar";
import * as jobs from "@/lib/peer-jobs";
import { peerHost, peerReachable, refreshStale } from "@/lib/peers";
import { searchAvailable, webSearch } from "@/lib/search";
import type { AgentPeer, Device } from "@/lib/types";
import { calendarGuidance, calendarTools } from "./calendar";
import { memoryBlock, memoryGuidance, memoryTools } from "./memory";
import { peerGuidance, peerStatus, peerTools } from "./peers";
import { AgentBusyError, callOnDevice, runTurn } from "./run";

// The fleet tools: see every device and command any online one. They are not the
// console's alone — every device agent gets the same set, so whichever terminal you are
// standing at is an access point to the rest (see buildTools in run.ts).
//
// Nothing here bypasses a device's own policy. A call still goes through that device's
// permission checks and approvals exactly as if its own agent had made it; being asked
// from somewhere else grants nothing extra.

const OUTPUT_CAP = 8_000;

function cap(text: string) {
  return text.length <= OUTPUT_CAP ? text : `${text.slice(0, OUTPUT_CAP)}\n… [truncated]`;
}

async function fleet(): Promise<Device[]> {
  // The browser console is itself a "web" device; it isn't something to command.
  return (await listDevices()).filter((d) => !(d.kind === "web" && d.hostname === "dashboard"));
}

async function resolveDevice(ref: string): Promise<Device> {
  const needle = ref.trim().toLowerCase();
  const devices = await fleet();
  const hit =
    devices.find((d) => d.id === ref) ??
    devices.find((d) => d.name.toLowerCase() === needle) ??
    devices.find((d) => d.id.startsWith(needle)) ??
    devices.filter((d) => d.name.toLowerCase().includes(needle)).at(0);
  if (!hit) throw new Error(`no device matches "${ref}". Known: ${devices.map((d) => d.name).join(", ") || "none"}`);
  return hit;
}

function onlineLink(device: Device) {
  const link = live.link(device.id);
  if (!link) throw new Error(`${device.name} is offline`);
  return link;
}

// An attached harness has no websocket, so every tool that reaches for a link has to
// turn it away first — `onlineLink` would otherwise report it as "offline", which is
// both wrong and a dead end for the model.
function notADevice(device: Device, instead: string): string {
  return `ERROR: ${device.name} is an attached agent, not a device — it exposes no tools of its own. ${instead}`;
}

// The peers, keyed by device id. Loaded only when the fleet actually holds one, so a
// setup with no attached agents pays nothing for them.
async function peersById(devices: Device[]): Promise<Map<string, AgentPeer>> {
  if (!devices.some((d) => d.kind === "agent")) return new Map();
  const rows = await listPeers();
  // Stale health readings get a probe started here, deliberately without awaiting it:
  // this runs on the way into every turn.
  refreshStale(rows);
  return new Map(rows.map((p) => [p.device_id, p]));
}

// The fleet as a prompt fragment. `selfId` marks the caller's own row, so a device
// agent can tell which line is the machine it is running on.
//
// `hasPeers` comes back with it rather than from a second query: both callers splice
// the peer guidance in only when there is something to use it on, and the device list
// has already been fetched here.
export async function fleetRoster(selfId?: string): Promise<{ roster: string; hasPeers: boolean }> {
  const devices = await fleet();
  if (!devices.length) return { roster: "- (no devices registered)", hasPeers: false };
  const peers = await peersById(devices);
  const roster = devices
    .map((d) => {
      const mine = d.id === selfId ? " — this device" : "";
      // Reachability, not presence: nothing connects to us, so there is no link to read.
      if (d.kind === "agent") return `- ${d.name} (agent) ${peerStatus(peers.get(d.id), d)}${mine}`;
      const link = live.link(d.id);
      if (!link) return `- ${d.name} (${d.kind}) offline${mine}`;
      const busy = link.run ? ", busy" : "";
      return `- ${d.name} (${d.kind}) online, access ${link.access?.level ?? "n/a"}, ${link.tools.length} tools${busy}${mine}`;
    })
    .join("\n");
  return { roster, hasPeers: peers.size > 0 };
}

// How to use the fleet tools. Shared, so the console and a device agent cannot drift
// apart on what the tools mean.
export function fleetGuidance(hasPeers = false): string[] {
  return [
    "- list_devices for fresh status; device_tools(device) before calling a device tool you haven't seen yet.",
    "- ask_device(device, prompt) hands a whole task to that device's own agent, in its live session",
    "  (the person at that device sees it). Best for multi-step work on one machine.",
    "- call_device_tool(device, tool, args) runs one precise action on a device. Best for quick reads,",
    "  or the same action on several devices (call it for each; they may run in parallel).",
    "- recent_activity(device?) reads the event log.",
    "- Each device's local policy decides every action: some need approval at the device or in the dashboard,",
    "  some are denied. If denied, don't retry or work around it; report it.",
    "- Always say which device each result came from.",
    ...(hasPeers ? peerGuidance() : []),
  ];
}

export async function masterInstructions(): Promise<string> {
  const { roster, hasPeers } = await fleetRoster();
  return [
    "You are the MASTER CONSOLE of AI-TERM, running in the admin's web dashboard.",
    "You can see every device and command any online one. Current fleet:",
    roster,
    "",
    // Global memories only. There is no device here, so the per-device scope has
    // nothing to be about.
    ...(await memoryBlock()),
    "",
    "How to act:",
    ...fleetGuidance(hasPeers),
    ...memoryGuidance(),
    ...((await calendarAvailable()) ? calendarGuidance() : []),
    ...(searchAvailable()
      ? ["- web_search(query, site?) for anything off this fleet: docs, errors, links. Never write a url from memory."]
      : []),
    "- Be concise.",
  ].join("\n");
}

export function masterTools(sessionId: string, hasCalendar = false): ToolSet {
  return {
    ...fleetTools(sessionId, { caller: "master console" }),
    // No `self`, so everything the console remembers is global.
    ...memoryTools(),
    // No `run` either: the fleet tools do not record themselves from here, and the
    // calendar is no different.
    ...(hasCalendar ? calendarTools() : {}),
    // agent_job is cheap and harmless with no peers configured: it answers "nothing is
    // outstanding", which is true.
    ...peerTools(),
    ...(searchAvailable()
      ? {
          web_search: tool({
            description:
              "Search the web. Returns real page titles, urls and extracts. Use it for any url you need, " +
              "for anything recent, and for anything you are not sure of. Never write a url from memory.",
            inputSchema: z.object({
              query: z.string().describe("what to search for"),
              site: z.string().optional().describe("restrict to one domain, e.g. youtube.com"),
            }),
            execute: async ({ query, site }) => {
              const hits = await webSearch(query, { site });
              if (!hits.length) return `no results for “${query}”${site ? ` on ${site}` : ""}`;
              return cap(hits.map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}\n   ${h.snippet}`).join("\n"));
            },
          }),
        }
      : {}),
  };
}

// `self` is the device the agent is running on, when it is running on one: it must not
// delegate a task back to itself, and it is worth marking in the roster.
export function fleetTools(sessionId: string, opts: { caller: string; self?: string } = { caller: "master console" }): ToolSet {
  const { caller, self } = opts;
  return {
    list_devices: tool({
      description: "All registered devices with online status, kind, access level, busy state and tool names.",
      inputSchema: z.object({}),
      execute: async () => {
        const devices = await fleet();
        const peers = await peersById(devices);
        return devices.map((d) => {
          if (d.kind === "agent") {
            const peer = peers.get(d.id);
            const busy = jobs.busyWith(d.id);
            return {
              name: d.name,
              id: d.id,
              kind: d.kind,
              // An attached agent is reached, not connected, so there is no "online"
              // for it to be. Saying so beats reporting a permanent offline.
              reachable: peer ? peerReachable(d.id) : "not configured",
              busy: Boolean(busy),
              job: busy?.id.slice(0, 8) ?? null,
              model: peer?.model ?? null,
              host: peer ? peerHost(peer.base_url) : null,
              tools: [] as string[],
              reach_with: "ask_device",
            };
          }
          const link = live.link(d.id);
          return {
            name: d.name,
            id: d.id,
            kind: d.kind,
            online: Boolean(link),
            busy: Boolean(link?.run),
            access: link?.access?.level ?? null,
            tools: link?.tools.map((t) => t.name) ?? [],
            hw: d.hw,
            last_seen_at: d.last_seen_at,
            ...(d.id === self ? { self: true } : {}),
          };
        });
      },
    }),

    device_tools: tool({
      description: "The tools one online device offers, with their JSON Schema parameters and risk level.",
      inputSchema: z.object({ device: z.string().describe("device name or id") }),
      execute: async ({ device }) => {
        const d = await resolveDevice(device);
        if (d.kind === "agent") return notADevice(d, "Give it the whole task with ask_device instead.");
        const link = onlineLink(d);
        return { device: d.name, access: link.access, tools: link.tools };
      },
    }),

    call_device_tool: tool({
      description:
        "Run one tool on an online device, e.g. read_file or run_command. The device's policy decides; it may need approval.",
      inputSchema: z.object({
        device: z.string().describe("device name or id"),
        tool: z.string().describe("tool name, from device_tools"),
        args: z.record(z.string(), z.unknown()).describe("arguments matching the tool's schema"),
      }),
      execute: async ({ device, tool: name, args }, { toolCallId, abortSignal }) => {
        const d = await resolveDevice(device);
        if (d.id === self) return `ERROR: that is this device. Call "${name}" directly instead of going through call_device_tool.`;
        if (d.kind === "agent") return notADevice(d, `Ask it to do "${name}" in plain words with ask_device.`);
        const link = onlineLink(d);
        const spec = link.tools.find((t) => t.name === name);
        if (!spec) return `ERROR: ${d.name} has no tool "${name}". It offers: ${link.tools.map((t) => t.name).join(", ") || "none"}`;
        // A distinct id per device call, so parallel calls from one step never collide.
        const callId = `${toolCallId}:${d.id.slice(0, 8)}`;
        const res = await callOnDevice(link, sessionId, spec, callId, args, abortSignal);
        await logEvent({
          device_id: d.id,
          type: "action",
          level: res.ok ? "info" : "warn",
          summary: `${caller}: ${name} ${res.ok ? "ok" : res.denied ? "denied" : "failed"}`,
          payload: { call_id: callId, args },
        }).catch(() => {});
        if (res.ok) return `[${d.name}] ${cap(res.output ?? "")}`;
        if (res.denied) return `[${d.name}] DENIED by the device's policy: ${res.error}. Do not retry.`;
        return `[${d.name}] ERROR: ${res.error}`;
      },
    }),

    ask_device: tool({
      description:
        "Give a task to a device's own agent. It runs in that device's live session (visible on the device) and returns its final answer. " +
        "Also how you reach an attached agent (kind 'agent'): same call, but it may take long enough to be handed off, " +
        "in which case you get a job id instead of an answer.",
      inputSchema: z.object({
        device: z.string().describe("device name or id"),
        prompt: z.string().min(1).max(4000).describe("what the device's agent should do, self-contained"),
      }),
      execute: async ({ device, prompt }, { abortSignal }) => {
        const d = await resolveDevice(device);
        // Delegating to yourself would deadlock on your own turn, which surfaces as
        // "busy" and reads like a fleet problem rather than a mistake.
        if (d.id === self) return "ERROR: that is this device. Do the task yourself rather than delegating it back.";

        // An attached harness is reached over HTTP instead of through a nested turn,
        // and may take minutes, so it gets the handoff treatment rather than holding
        // this turn open. Everything else about the tool is unchanged.
        if (d.kind === "agent") {
          const peer = await getPeer(d.id);
          if (!peer) return `ERROR: ${d.name} has no base url set yet, so it cannot be asked anything. Set one in the dashboard.`;
          try {
            const res = await jobs.start({ peer, device: d, task: prompt, sessionId, askedBy: self, abortSignal });
            if (res.kind === "answer") return `[${d.name}] ${cap(res.answer)}`;
            if (res.kind === "failed") return `[${d.name}] ERROR: ${res.error}`;
            const short = res.jobId.slice(0, 8);
            return (
              `[${d.name}] still working — job ${short}. Tell the user it is running and stop there; ` +
              `do not ask again. The answer arrives on its own as a notification, and agent_job("${short}") reads it in full.`
            );
          } catch (err) {
            if (err instanceof jobs.PeerBusyError) return `[${d.name}] ${err.message}. Wait for it, or pick another agent.`;
            throw err;
          }
        }

        const link = onlineLink(d);
        try {
          const turn = runTurn(link, prompt, "web");
          // runTurn claims the device synchronously; stopping the console stops the delegated turn too.
          const run = link.run;
          abortSignal?.addEventListener("abort", () => run?.abort.abort(), { once: true });
          const result = await turn;
          if (result.error) return `[${d.name}] ERROR: ${result.error}`;
          if (result.aborted) return `[${d.name}] the turn was aborted. Partial answer: ${cap(result.reply)}`;
          return `[${d.name}] ${cap(result.reply)}`;
        } catch (err) {
          // Now that every device has these tools, B can delegate onwards to C. The
          // busy check is what bounds it: everyone already in the chain is mid-turn, so
          // a cycle comes straight back as "busy" and the depth cannot exceed the
          // number of devices.
          if (err instanceof AgentBusyError) return `[${d.name}] is busy with another task right now. Try again later, or pick another device.`;
          throw err;
        }
      },
    }),

    recent_activity: tool({
      description: "Recent events (connects, chats, tool actions, errors, logs), for one device or the whole fleet.",
      inputSchema: z.object({
        device: z.string().optional().describe("device name or id; omit for all devices"),
        limit: z.number().int().min(1).max(100).optional(),
      }),
      execute: async ({ device, limit }) => {
        const d = device ? await resolveDevice(device) : null;
        const events = await listEvents({ deviceId: d?.id, limit: limit ?? 30 });
        return events.map((e) => ({
          at: e.created_at,
          device: e.device?.name ?? null,
          type: e.type,
          level: e.level,
          summary: e.summary,
        }));
      },
    }),

  };
}
