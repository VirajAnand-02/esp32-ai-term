import { db, must } from "../supabase";
import type { Memory } from "../types";

export async function listMemories(): Promise<Memory[]> {
  return must(await db().from("memories").select("*").order("created_at", { ascending: false }));
}

// What the agent is allowed to see: every global memory, plus the ones belonging to
// the device it is speaking through, and only those switched on. Deliberately not
// listMemories, which returns disabled rows too so the dashboard can grey them out.
//
// `device_id is null` is the global scope — that is what the column has meant since
// the table was created; it just had no reader until now.
export async function memoriesFor(deviceId: string | null): Promise<Memory[]> {
  const q = db().from("memories").select("*").eq("enabled", true).order("created_at", { ascending: false });
  if (!deviceId) return must(await q.is("device_id", null));
  return must(await q.or(`device_id.is.null,device_id.eq.${deviceId}`));
}

// Returns the row, unlike the fire-and-forget it used to be: a `remember` tool has
// to be able to tell the model what it saved and under which id.
export async function createMemory(m: {
  content: string;
  tags: string[];
  device_id: string | null;
}): Promise<Memory> {
  return must(await db().from("memories").insert(m).select("*").single());
}

export async function setMemoryEnabled(id: string, enabled: boolean) {
  must(await db().from("memories").update({ enabled }).eq("id", id).select("id").single());
}

export async function deleteMemory(id: string) {
  must(await db().from("memories").delete().eq("id", id).select("id"));
}
