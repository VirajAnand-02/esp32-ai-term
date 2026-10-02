import { listDevices } from "@/lib/db/devices";
import { live } from "@/lib/live";

export const dynamic = "force-dynamic";

// Every device's live state plus anything waiting for approval, for the master console.
export async function GET() {
  const devices = (await listDevices()).filter((d) => !(d.kind === "web" && d.hostname === "dashboard"));
  return Response.json({
    devices: devices.map((d) => {
      const link = live.link(d.id);
      return {
        id: d.id,
        name: d.name,
        kind: d.kind,
        online: Boolean(link),
        busy: Boolean(link?.run),
        access: link?.access ?? null,
        tools: link?.tools.map((t) => t.name) ?? [],
      };
    }),
    pending: devices.flatMap((d) =>
      [...(live.link(d.id)?.pending.values() ?? [])]
        .filter((p) => p.row.status === "awaiting_approval")
        .map((p) => p.row),
    ),
  });
}
