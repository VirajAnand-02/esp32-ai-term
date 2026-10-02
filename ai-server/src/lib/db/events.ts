import { publish } from "../bus";
import { db, must } from "../supabase";
import type { EventRow, EventType, Level } from "../types";

const COLUMNS = "id, device_id, type, level, summary, payload, created_at, device:devices(name, kind)";

export type EventFilter = {
  deviceId?: string;
  types?: EventType[];
  levels?: Level[];
  search?: string;
  before?: number;
  limit?: number;
};

export async function listEvents(f: EventFilter = {}): Promise<EventRow[]> {
  let q = db()
    .from("events")
    .select(COLUMNS)
    .order("id", { ascending: false })
    .limit(f.limit ?? 100);
  if (f.deviceId) q = q.eq("device_id", f.deviceId);
  if (f.types?.length) q = q.in("type", f.types);
  if (f.levels?.length) q = q.in("level", f.levels);
  if (f.search) q = q.ilike("summary", `%${f.search.replace(/[%_]/g, "\\$&")}%`);
  if (f.before) q = q.lt("id", f.before);
  return must(await q) as unknown as EventRow[];
}

// Persists an event and pushes it to live dashboards.
export async function logEvent(input: {
  device_id: string | null;
  type: EventType;
  level?: Level;
  summary: string;
  payload?: Record<string, unknown> | null;
}): Promise<EventRow> {
  const row = must(
    await db()
      .from("events")
      .insert({ level: "info", ...input, summary: input.summary.slice(0, 500) })
      .select(COLUMNS)
      .single(),
  ) as unknown as EventRow;
  publish({ kind: "event", event: row });
  return row;
}
