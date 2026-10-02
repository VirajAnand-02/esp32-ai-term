import { z } from "zod";
import { runTurn } from "@/agent/run";
import { getPeer } from "@/lib/db/agents";
import { getDevice } from "@/lib/db/devices";
import { getOrCreateSession, latestSession } from "@/lib/db/sessions";
import { live } from "@/lib/live";
import * as jobs from "@/lib/peer-jobs";

export const dynamic = "force-dynamic";

const body = z.object({ text: z.string().trim().min(1).max(8000) });

// Sends a prompt into the device's live session as if typed on the device (origin "web").
// Returns immediately; the turn streams to the device and to dashboards over SSE.
//
// An attached agent has no live session to stream into — nothing connects to us — so it
// takes the HTTP path instead and the answer comes back in this response. Same job
// machinery as `ask_device`, so the handoff, the one-task-at-a-time guard and the
// tool_calls row the live tab renders all behave identically.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "bad request" }, { status: 400 });
  const text = parsed.data.text;

  const device = await getDevice(id).catch(() => null);
  if (!device) return Response.json({ error: "no such device" }, { status: 404 });

  if (device.kind === "agent") {
    const peer = await getPeer(id).catch(() => null);
    if (!peer) return Response.json({ error: "this agent has no endpoint set yet" }, { status: 409 });

    // The tool_calls row is FK'd to a session, and asks from the dashboard have none of
    // their own. Reusing the peer's latest one keeps them together as a running log.
    const session =
      (await latestSession(id).catch(() => null)) ??
      (await getOrCreateSession({ deviceId: id, title: text, model: peer.model ?? "harness" }));

    try {
      const res = await jobs.start({ peer, device, task: text, sessionId: session.id });
      if (res.kind === "answer") return Response.json({ ok: true, answer: res.answer }, { status: 200 });
      if (res.kind === "failed") return Response.json({ error: res.error }, { status: 502 });
      return Response.json({ ok: true, handedOff: true, jobId: res.jobId }, { status: 202 });
    } catch (err) {
      if (err instanceof jobs.PeerBusyError) return Response.json({ error: err.message }, { status: 409 });
      throw err;
    }
  }

  const link = live.link(id);
  if (!link) return Response.json({ error: "device is offline" }, { status: 409 });
  if (link.run) return Response.json({ error: "the agent is already working on this device" }, { status: 409 });

  void runTurn(link, text, "web").catch((err) => console.error("[prompt]", (err as Error).message));
  return Response.json({ ok: true }, { status: 202 });
}
