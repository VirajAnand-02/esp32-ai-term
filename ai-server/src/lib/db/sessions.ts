import { db, must } from "../supabase";
import type { Message, Session } from "../types";

export async function listSessions(deviceId: string, limit = 20): Promise<Session[]> {
  const rows = must(
    await db()
      .from("sessions")
      .select("*, messages(*)")
      .eq("device_id", deviceId)
      .order("started_at", { ascending: false })
      .limit(limit),
  ) as Session[];
  for (const s of rows) s.messages?.sort((a, b) => a.id - b.id);
  return rows;
}

export async function getOrCreateSession(opts: {
  id?: string;
  deviceId: string;
  title: string;
  model: string;
}): Promise<Session> {
  if (opts.id) {
    const existing = must(
      await db().from("sessions").select("*").eq("id", opts.id).eq("device_id", opts.deviceId).maybeSingle(),
    ) as Session | null;
    if (existing) return existing;
  }
  return must(
    await db()
      .from("sessions")
      .insert({
        ...(opts.id ? { id: opts.id } : {}),
        device_id: opts.deviceId,
        title: opts.title.slice(0, 80),
        model: opts.model,
      })
      .select("*")
      .single(),
  );
}

export async function recentMessages(sessionId: string, limit = 20): Promise<Message[]> {
  const rows = must(
    await db()
      .from("messages")
      .select("*")
      .eq("session_id", sessionId)
      .order("id", { ascending: false })
      .limit(limit),
  ) as Message[];
  return rows.reverse();
}

export async function addMessage(m: Omit<Message, "id" | "created_at">) {
  const res = await db().from("messages").insert(m).select("id").single();
  // Before 0002_agent.sql the origin column doesn't exist; store the message without it.
  if (res.error && m.origin && /origin/.test(res.error.message)) {
    const rest = { ...m };
    delete rest.origin;
    must(await db().from("messages").insert(rest).select("id").single());
    return;
  }
  must(res);
}

export async function latestSession(deviceId: string): Promise<Session | null> {
  return must(
    await db().from("sessions").select("*").eq("device_id", deviceId).order("started_at", { ascending: false }).limit(1).maybeSingle(),
  );
}

export async function sessionMessages(sessionId: string): Promise<Message[]> {
  return must(await db().from("messages").select("*").eq("session_id", sessionId).order("id")) as Message[];
}

export async function addSessionUsage(session: Session, input: number, output: number, model: string) {
  must(
    await db()
      .from("sessions")
      .update({
        input_tokens: session.input_tokens + input,
        output_tokens: session.output_tokens + output,
        model,
        ended_at: new Date().toISOString(),
      })
      .eq("id", session.id)
      .select("id")
      .single(),
  );
}

export async function getSession(id: string): Promise<Session | null> {
  return must(await db().from("sessions").select("*").eq("id", id).maybeSingle());
}
