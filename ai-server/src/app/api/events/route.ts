import { listEvents } from "@/lib/db/events";
import { EVENT_TYPES, LEVELS, type EventType, type Level } from "@/lib/types";

export const dynamic = "force-dynamic";

// Paging for the log explorer: /api/events?before=<id>&device=<uuid>&type=chat,log&level=error&q=text
export async function GET(req: Request) {
  const p = new URL(req.url).searchParams;
  const list = <T extends string>(key: string, allowed: readonly T[]) =>
    (p.get(key)?.split(",").filter((v): v is T => (allowed as readonly string[]).includes(v))) ?? [];

  const events = await listEvents({
    deviceId: p.get("device") || undefined,
    types: list<EventType>("type", EVENT_TYPES),
    levels: list<Level>("level", LEVELS),
    search: p.get("q") || undefined,
    before: Number(p.get("before")) || undefined,
    limit: Math.min(Number(p.get("limit")) || 100, 500),
  });
  return Response.json({ events });
}
