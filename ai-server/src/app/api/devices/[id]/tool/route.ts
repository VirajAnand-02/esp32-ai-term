import { randomUUID } from "node:crypto";
import { z } from "zod";
import { callOnDevice } from "@/agent/run";
import { getOrCreateSession } from "@/lib/db/sessions";
import { live } from "@/lib/live";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const body = z.object({
  name: z.string().min(1),
  args: z.record(z.string(), z.unknown()).default({}),
});

// Runs one of the device's tools directly, with no model in the loop. The dashboard
// uses this for hardware test panels; the call is still logged and still goes through
// the device's own permission policy.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const parsed = body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return Response.json({ error: "give a tool name and its arguments" }, { status: 400 });

  const link = live.link(id);
  if (!link) return Response.json({ error: "device is offline" }, { status: 409 });

  const spec = link.tools.find((t) => t.name === parsed.data.name);
  if (!spec) return Response.json({ error: `this device has no "${parsed.data.name}" tool` }, { status: 409 });

  const session = await getOrCreateSession({
    id: link.activeSessionId ?? undefined,
    deviceId: id,
    title: "hardware test",
    model: "none",
  });
  link.activeSessionId = session.id;

  const result = await callOnDevice(link, session.id, spec, randomUUID(), parsed.data.args);
  return Response.json({ ok: result.ok, output: result.output ?? null, error: result.error ?? null, denied: Boolean(result.denied) });
}
