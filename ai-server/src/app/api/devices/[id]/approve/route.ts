import { z } from "zod";
import { sendToDevice } from "@/agent/run";
import { logEvent } from "@/lib/db/events";
import { live } from "@/lib/live";

export const dynamic = "force-dynamic";

const body = z.object({ call_id: z.string().min(1).max(128), approved: z.boolean() });

// Forwards an approval decision to the device. The device re-checks it against its own
// policy, so this can only ever unblock something the device already asked about.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "bad request" }, { status: 400 });
  const { call_id, approved } = parsed.data;

  const link = live.link(id);
  if (!link) return Response.json({ error: "device is offline" }, { status: 409 });
  if (!link.access?.remote_approval) {
    return Response.json({ error: "this device only accepts approvals on the device itself" }, { status: 403 });
  }
  const pending = link.pending.get(call_id);
  if (!pending || pending.row.status !== "awaiting_approval") {
    return Response.json({ error: "that call is not waiting for approval" }, { status: 409 });
  }

  sendToDevice(link, { type: "tool.approve", call_id, approved });
  await logEvent({
    device_id: id,
    type: "action",
    level: approved ? "info" : "warn",
    summary: `${approved ? "approved" : "denied"} ${pending.row.name} from the dashboard`,
    payload: { call_id, args: pending.row.args },
  });
  return Response.json({ ok: true });
}
