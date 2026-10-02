import { randomUUID } from "node:crypto";
import { publish } from "./bus";
import { logEvent } from "./db/events";
import { saveToolCall } from "./db/tool-calls";
import { live } from "./live";
import { askPeer } from "./peers";
import type { AgentPeer, Device, ToolCallRow } from "./types";

// Delegating to an attached harness, which may take minutes.
//
// A device agent cannot block for minutes -- somebody is standing at the panel waiting
// for an answer -- and always deferring would make "what is 2+2" take two round trips.
// So the request is raced against a short handoff window: quick answers come back
// inline like any other tool, and a slow one keeps running in the background while the
// turn reports a job id. Nothing polls and the harness needs no callback: the fetch we
// already have is the completion signal.
//
// The job registry is in-process, like `live` and `bus`. A restart loses outstanding
// jobs, which is honest -- the server is restarted by hand for every build anyway -- and
// the tool_calls row is what survives for the dashboard.

const HANDOFF_MS = 60_000;
const STORED_OUTPUT = 4_000;
// notify.h caps a notification body at 96 bytes, and the title eats some of the line.
const NOTICE_MAX = 90;

export type Job = {
  id: string;
  peerId: string;
  peerName: string;
  askedBy?: string; // the device that delegated; absent from the console
  task: string;
  status: "running" | "ok" | "error";
  answer?: string;
  error?: string;
  startedAt: number;
  finishedAt?: number;
};

export class PeerBusyError extends Error {}

const g = globalThis as {
  __aitermPeerJobs?: { jobs: Map<string, Job>; busy: Map<string, string> };
};
const reg = (g.__aitermPeerJobs ??= { jobs: new Map(), busy: new Map() });

/** Cut to a length without splitting a surrogate pair -- see the note in lib/search.ts. */
function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const chars = [...flat];
  return chars.length <= max ? flat : `${chars.slice(0, max - 1).join("")}…`;
}

export function get(idRef: string): Job | undefined {
  const needle = idRef.trim().toLowerCase();
  return reg.jobs.get(needle) ?? [...reg.jobs.values()].find((j) => j.id.startsWith(needle));
}

/** Jobs still out at a peer, newest first. Used for the roster's "busy". */
export function listOpen(peerId?: string): Job[] {
  return [...reg.jobs.values()]
    .filter((j) => j.status === "running" && (!peerId || j.peerId === peerId))
    .sort((a, b) => b.startedAt - a.startedAt);
}

export function busyWith(peerId: string): Job | undefined {
  const id = reg.busy.get(peerId);
  return id ? reg.jobs.get(id) : undefined;
}

// The row is written here rather than through `runHere`, which marks a call terminal
// the moment its body returns -- the wrong moment for a job that has been handed off.
// Attribution follows call_device_tool: the row belongs to the caller's session but
// lands on the device it was aimed at, so a peer's own page becomes the log of what it
// has been asked.
function rowFor(job: Job, sessionId: string): ToolCallRow {
  return {
    id: job.id,
    session_id: sessionId,
    device_id: job.peerId,
    name: "ask_agent",
    args: { task: job.task, ...(job.askedBy ? { asked_by: job.askedBy } : {}) },
    risk: "exec",
    status: "running",
    reason: null,
    output: null,
    decided_by: "server",
    created_at: new Date(job.startedAt).toISOString(),
    finished_at: null,
  };
}

async function record(row: ToolCallRow) {
  await saveToolCall(row);
  publish({ kind: "session", deviceId: row.device_id, frame: { type: "tool", call: { ...row } } });
}

export type StartResult =
  | { kind: "answer"; answer: string }
  | { kind: "failed"; error: string }
  // Still running. It will arrive as a notification, and agent_job has the full text.
  | { kind: "handed-off"; jobId: string };

export async function start(opts: {
  peer: AgentPeer;
  device: Device;
  task: string;
  sessionId: string;
  askedBy?: string;
  // The asking turn's signal. It does *not* cancel the task — a harness that is
  // already working should finish — it only stops this turn waiting, which is the
  // same thing as handing off.
  abortSignal?: AbortSignal;
}): Promise<StartResult> {
  const { peer, device, task, sessionId, askedBy, abortSignal } = opts;

  // One task at a time per peer, the same bound `link.run` puts on delegating to a
  // device: a delegation cycle comes straight back as "busy" instead of multiplying.
  const already = busyWith(peer.device_id);
  if (already) {
    throw new PeerBusyError(
      `${device.name} is already working on something (job ${already.id.slice(0, 8)}, ` +
        `started ${Math.round((Date.now() - already.startedAt) / 1000)}s ago)`,
    );
  }

  const job: Job = {
    id: randomUUID(),
    peerId: peer.device_id,
    peerName: device.name,
    askedBy,
    task,
    status: "running",
    startedAt: Date.now(),
  };
  reg.jobs.set(job.id, job);
  reg.busy.set(peer.device_id, job.id);

  const row = rowFor(job, sessionId);
  await record(row).catch(() => {});

  const settle = askPeer(peer, task).then(
    (answer) => ({ answer }),
    (err: Error) => ({ error: err.message }),
  );

  // The fetch runs to its own timeout whatever happens here; this only decides whether
  // *this turn* waits for it. Either the clock or an abort gives up waiting, and both
  // mean the same thing: the answer will have to arrive on its own.
  const handoff = new Promise<"later">((resolve) => {
    setTimeout(() => resolve("later"), HANDOFF_MS).unref?.();
    abortSignal?.addEventListener("abort", () => resolve("later"), { once: true });
  });
  const first = await Promise.race([settle, handoff]);

  if (first !== "later") {
    // `notify` is false, not re-derived from the clock: if the event loop stalled past
    // the handoff window the answer is still going back inline, and a notification
    // about something already on the screen is noise.
    await finish(job, row, first, false);
    return "error" in first ? { kind: "failed", error: first.error } : { kind: "answer", answer: first.answer };
  }

  // Handed off. Deliver whenever it lands.
  void settle.then((result) => void finish(job, row, result, true).catch(() => {}));
  return { kind: "handed-off", jobId: job.id };
}

async function finish(
  job: Job,
  row: ToolCallRow,
  result: { answer: string } | { error: string },
  notify: boolean,
) {
  if (job.status !== "running") return; // already settled; a double delivery would duplicate the notice

  if ("error" in result) {
    job.status = "error";
    job.error = result.error;
  } else {
    job.status = "ok";
    job.answer = result.answer;
  }
  job.finishedAt = Date.now();
  reg.busy.delete(job.peerId);

  row.status = job.status;
  row.output = (job.answer ?? job.error ?? "").slice(0, STORED_OUTPUT);
  row.finished_at = new Date(job.finishedAt).toISOString();
  await record(row).catch(() => {});

  // Nothing more to do for a job the turn is still holding: its own return value is
  // the delivery.
  if (!notify) return;

  const headline = job.answer
    ? `${job.peerName}: ${clip(job.answer, NOTICE_MAX - job.peerName.length - 2)}`
    : `${job.peerName} failed: ${clip(job.error ?? "", NOTICE_MAX - job.peerName.length - 9)}`;

  await logEvent({
    device_id: job.peerId,
    type: "action",
    level: job.status === "ok" ? "info" : "warn",
    summary: `job ${job.id.slice(0, 8)} ${job.status} after ${Math.round((job.finishedAt - job.startedAt) / 1000)}s`,
    payload: { asked_by: job.askedBy ?? null, task: job.task.slice(0, 200) },
  }).catch(() => {});

  // `notice` is all this needs: on the device `on_notice` already posts it to the
  // notification ring and flashes it, so a handed-off answer turns up in the drawer
  // with no firmware change at all. The full text stays in the job, for agent_job.
  if (job.askedBy) live.send(job.askedBy, { type: "notice", msg: headline });
}
