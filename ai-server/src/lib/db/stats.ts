import { db, must } from "../supabase";

export type DashboardStats = {
  devicesOnline: number;
  devicesTotal: number;
  sessionsToday: number;
  messages24h: number;
  tokensToday: number;
  errors24h: number;
  hourly: { hour: string; events: number; chats: number; errors: number }[];
  daily: { day: string; events: number; errors: number; sessions: number; tokens: number }[];
  models: { model: string; sessions: number; tokens: number }[];
};

type CountResult = { count: number | null; status: number; error: { message: string } | null };

// HEAD requests carry no error body: a missing table comes back as 204 with no
// count, while a real one always reports a number (0 when empty).
async function count(query: PromiseLike<CountResult>) {
  const res = await query;
  if (res.error?.message) throw new Error(res.error.message);
  if (res.status >= 400) throw new Error(`Supabase returned HTTP ${res.status}`);
  if (res.count === null) throw new Error("table not found: has supabase/migrations/0001_init.sql been run?");
  return res.count;
}

const head = (table: string) => db().from(table).select("*", { count: "exact", head: true });

export async function getDashboardStats(): Promise<DashboardStats> {
  const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);

  const [devicesTotal, devicesOnline, sessionsToday, messages24h, errors24h, hourly, daily, models] =
    await Promise.all([
      count(head("devices")),
      count(head("devices").eq("status", "online")),
      count(head("sessions").gte("started_at", midnight.toISOString())),
      count(head("messages").gte("created_at", dayAgo)),
      count(head("events").eq("level", "error").gte("created_at", dayAgo)),
      db().from("stats_hourly").select("*").then(must),
      db().from("stats_daily").select("*").then(must),
      db().from("model_usage").select("*").then(must),
    ]);

  const dailyRows = (daily as DashboardStats["daily"]).map((d) => ({
    ...d,
    events: Number(d.events),
    errors: Number(d.errors),
    sessions: Number(d.sessions),
    tokens: Number(d.tokens),
  }));

  return {
    devicesTotal,
    devicesOnline,
    sessionsToday,
    messages24h,
    errors24h,
    tokensToday: dailyRows.at(-1)?.tokens ?? 0,
    hourly: (hourly as DashboardStats["hourly"]).map((h) => ({
      ...h,
      events: Number(h.events),
      chats: Number(h.chats),
      errors: Number(h.errors),
    })),
    daily: dailyRows,
    models: (models as DashboardStats["models"]).map((m) => ({
      ...m,
      sessions: Number(m.sessions),
      tokens: Number(m.tokens),
    })),
  };
}

export async function tableCounts(): Promise<{ table: string; rows: number; ms: number }[]> {
  const tables = ["devices", "sessions", "messages", "events", "memories", "settings"];
  return Promise.all(
    tables.map(async (table) => {
      const t0 = performance.now();
      const rows = await count(head(table));
      return { table, rows, ms: Math.round(performance.now() - t0) };
    }),
  );
}
