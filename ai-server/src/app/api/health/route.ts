import { live } from "@/lib/live";

export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ ok: true, uptime: Math.round(process.uptime()), devices_connected: live.count() });
}
