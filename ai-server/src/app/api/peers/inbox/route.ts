import { z } from "zod";
import { findDeviceByToken, listDevices } from "@/lib/db/devices";
import { logEvent } from "@/lib/db/events";
import { live } from "@/lib/live";
import type { Device } from "@/lib/types";

export const dynamic = "force-dynamic";

// An attached agent saying something nobody asked for.
//
// The other direction -- us delegating a task -- needs nothing from the harness but an
// HTTP endpoint. This is the half that lets it start the conversation: a finished
// deploy, a watch that tripped, an answer to something from yesterday.
//
// It arrives as a `notice`, which is all it needs to: on the device `on_notice`
// already posts to the notification ring and flashes it on the panel, so this turns up
// in the drawer with no firmware change. Deliberately *not* a message row -- an
// unprompted line is a notification, not a conversation turn, and keeping it out of the
// transcript leaves `messages.origin` and every runTurn signature alone.
//
// Note this path is excluded from the admin-cookie check in src/proxy.ts and does its
// own auth, exactly as /ws does. Adding another route under /api/peers inherits that,
// so anything put here has to authenticate itself.

const NOTICE_MAX = 90;

const body = z.object({
  text: z.string().trim().min(1, "text is required").max(4000),
  // Which device to tell. Optional while there is only one it could mean.
  device: z.string().trim().max(64).optional(),
});

function tokenFrom(req: Request): string {
  const header = req.headers.get("authorization") ?? "";
  const bearer = /^Bearer\s+(.+)$/i.exec(header)?.[1];
  if (bearer) return bearer.trim();
  return new URL(req.url).searchParams.get("token")?.trim() ?? "";
}

// Cut to a length without splitting a surrogate pair, and flatten newlines: the panel
// gets one line of 96 bytes. See the truncation note in AGENTS.md.
function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const chars = [...flat];
  return chars.length <= max ? flat : `${chars.slice(0, max - 1).join("")}…`;
}

// Somewhere a notification makes sense: not another agent, and not the dashboard.
function notifiable(devices: Device[]): Device[] {
  return devices.filter((d) => d.kind !== "agent" && d.kind !== "web");
}

export async function POST(req: Request) {
  const token = tokenFrom(req);
  if (!token) return Response.json({ error: "no token" }, { status: 401 });

  let peer: Device | null;
  try {
    peer = await findDeviceByToken(token);
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 503 });
  }
  if (!peer) return Response.json({ error: "unknown token" }, { status: 401 });
  // A device token must not become a way to push notices around the fleet: this route
  // is for attached agents, and a device has the websocket for everything else.
  if (peer.kind !== "agent") {
    return Response.json({ error: "this token is not an attached agent's" }, { status: 403 });
  }

  const parsed = body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return Response.json({ error: parsed.error.issues[0]?.message ?? "bad request" }, { status: 400 });
  }
  const { text, device } = parsed.data;

  const candidates = notifiable(await listDevices());
  let target: Device | undefined;
  if (device) {
    const needle = device.toLowerCase();
    target =
      candidates.find((d) => d.id === device) ??
      candidates.find((d) => d.name.toLowerCase() === needle) ??
      candidates.find((d) => d.id.startsWith(needle)) ??
      candidates.filter((d) => d.name.toLowerCase().includes(needle)).at(0);
    if (!target) {
      return Response.json(
        { error: `no device matches "${device}"`, devices: candidates.map((d) => d.name) },
        { status: 400 },
      );
    }
  } else if (candidates.length === 1) {
    target = candidates[0];
  } else {
    return Response.json(
      {
        error: candidates.length ? "say which device, there is more than one" : "there is no device to notify",
        devices: candidates.map((d) => d.name),
      },
      { status: 400 },
    );
  }

  const msg = clip(`${peer.name}: ${text}`, NOTICE_MAX);
  const delivered = live.send(target.id, { type: "notice", msg });

  await logEvent({
    device_id: peer.id,
    type: "chat",
    level: delivered ? "info" : "warn",
    summary: `→ ${target.name}: ${text.slice(0, 200)}`,
    payload: { to: target.id, delivered, full: text.slice(0, 2000) },
  }).catch(() => {});

  // `delivered: false` means the device was not connected, so the notice is gone
  // rather than queued — the harness should know that, not assume it landed.
  return Response.json({ ok: true, delivered, to: target.name }, { status: 202 });
}
