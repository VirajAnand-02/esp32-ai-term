import { z } from "zod";
import { sendToDevice } from "@/agent/run";
import { logEvent } from "@/lib/db/events";
import { live } from "@/lib/live";

export const dynamic = "force-dynamic";

const body = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("add"),
    ssid: z.string().min(1).max(32),
    // WPA2 allows 8 to 63 characters; empty is an open network.
    password: z.string().max(63).default(""),
  }),
  z.object({ action: z.literal("forget"), ssid: z.string().min(1).max(32) }),
]);

// Adds or removes a saved network on the device.
//
// One way only: the credential goes down and nothing comes back but the list of
// names. The device clamps, stores and decides — a push is a request, exactly as it
// is for settings — and it will not leave a working link to join what was just
// added, because staying put is the policy on the device.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const parsed = body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return Response.json({ error: parsed.error.issues[0]?.message ?? "bad request" }, { status: 400 });
  }

  const link = live.link(id);
  if (!link) return Response.json({ error: "device is offline" }, { status: 409 });

  const msg = parsed.data;
  if (msg.action === "add") {
    sendToDevice(link, { type: "wifi.add", ssid: msg.ssid, password: msg.password });
  } else {
    sendToDevice(link, { type: "wifi.forget", ssid: msg.ssid });
  }

  // The password is not in the summary, and must not be.
  await logEvent({
    device_id: id,
    type: "command",
    summary: `wifi ${msg.action}: ${msg.ssid}`,
  }).catch(() => {});

  return Response.json({ ok: true });
}
