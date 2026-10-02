import { tool, type ToolSet } from "ai";
import { z } from "zod";
import * as jobs from "@/lib/peer-jobs";
import { peerReachable } from "@/lib/peers";
import type { AgentPeer, Device } from "@/lib/types";
import type { RunHere } from "./memory";

// The attached agent harnesses, as the model sees them.
//
// A peer is a device of kind "agent" whose transport is HTTP-out rather than
// WebSocket-in, so `ask_device` reaches it through src/lib/peer-jobs.ts instead of
// through a nested runTurn. Everything else about it -- the name, the roster line, the
// event log -- is the ordinary device machinery.

const OUTPUT_CAP = 8_000;

/** How a peer's roster line reads after "- name (agent) ". */
export function peerStatus(peer: AgentPeer | undefined, device: Device): string {
  if (!peer) return "not configured yet — no base url, so it cannot be asked anything";
  const busy = jobs.busyWith(device.id);
  const bits: string[] = [];
  const reach = peerReachable(device.id);
  bits.push(reach === "yes" ? "reachable" : reach === "no" ? "unreachable" : "not checked yet");
  if (peer.model) bits.push(peer.model);
  if (busy) bits.push(`busy since ${Math.round((Date.now() - busy.startedAt) / 1000)}s ago, job ${busy.id.slice(0, 8)}`);
  return bits.join(", ");
}

// Shared so the console and every device agent are told the same thing about them.
export function peerGuidance(): string[] {
  return [
    "- Some fleet entries are kind (agent): attached harnesses that run on a real computer with their own",
    "  tools, memory and shell. ask_device is how you reach one; they expose no tools of their own, so",
    "  device_tools and call_device_tool do not apply to them.",
    "- Delegate to one when the task is long, open-ended or needs a real machine: reading a repo, writing or",
    "  running code, driving a browser, anything that would take many steps. Give it the whole task in one",
    "  self-contained message, including any context it cannot see from here — it starts fresh every time.",
    "- Do not delegate anything about this device, anything you can already answer, or anything quick. A",
    "  round trip to a harness costs far more than doing it here.",
    "- They are slow. If one does not answer within a minute you get a job id instead of an answer; say so",
    "  plainly, and stop there. The answer arrives on its own as a notification, and agent_job(id) reads",
    "  the full text once it has.",
    "- An attached agent cannot touch this device or the fleet. Whatever it reports is its word, not a",
    "  verified result.",
  ];
}

export function peerTools(opts: { run?: RunHere } = {}): ToolSet {
  const { run } = opts;
  const here = (name: string, args: Record<string, unknown>, body: () => Promise<string>) =>
    run ? run(name, args, body, "read") : body();

  return {
    agent_job: tool({
      description:
        "Read a delegated task that was handed off because it took too long to answer inside the turn. " +
        "Give the job id from the brackets. Returns the full answer, or that it is still running.",
      inputSchema: z.object({ id: z.string().describe("the job id, e.g. 3f2a1c9b") }),
      execute: async ({ id }) =>
        here("agent_job", { id }, async () => {
          const job = jobs.get(id);
          if (!job) {
            const open = jobs.listOpen();
            throw new Error(
              `no job "${id}". ${
                open.length
                  ? `Still running: ${open.map((j) => `${j.id.slice(0, 8)} at ${j.peerName}`).join(", ")}`
                  : "Nothing is outstanding."
              }`,
            );
          }
          const age = Math.round(((job.finishedAt ?? Date.now()) - job.startedAt) / 1000);
          if (job.status === "running") return `[${job.peerName}] still working, ${age}s so far. Nothing to report yet.`;
          if (job.status === "error") return `[${job.peerName}] failed after ${age}s: ${job.error}`;
          const answer = job.answer ?? "";
          return `[${job.peerName}] answered after ${age}s:\n${
            answer.length <= OUTPUT_CAP ? answer : `${answer.slice(0, OUTPUT_CAP)}\n… [truncated]`
          }`;
        }),
    }),
  };
}
