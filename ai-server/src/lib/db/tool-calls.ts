import { db, must } from "../supabase";
import type { ToolCallRow } from "../types";

// Tool-call persistence is best-effort: a missing 0002 migration must not break the agent.
let warned = false;
function soft(err: unknown) {
  if (!warned) {
    warned = true;
    console.error("[tool_calls] not persisted (has 0002_agent.sql been run?):", (err as Error).message);
  }
}

// Tool output is arbitrary text from the outside world. A lone surrogate — half an
// emoji, usually left behind by a length cap — is valid in a JS string but not in JSON,
// and PostgREST rejects the whole request with "Empty or invalid json"; a NUL Postgres
// will not store at all. Neither is worth losing the row over, so both are dropped here
// rather than left for each tool to remember.
const UNPAIRED = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

function scrub<T>(value: T): T {
  if (typeof value === "string") return value.replace(UNPAIRED, "").replace(/\u0000/g, "") as T;
  if (Array.isArray(value)) return value.map(scrub) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v)])) as T;
  }
  return value;
}

export async function saveToolCall(row: ToolCallRow) {
  try {
    must(await db().from("tool_calls").upsert(scrub(row)).select("id").single());
  } catch (err) {
    soft(err);
  }
}

export async function listToolCalls(sessionId: string): Promise<ToolCallRow[]> {
  try {
    return must(await db().from("tool_calls").select("*").eq("session_id", sessionId).order("created_at")) as ToolCallRow[];
  } catch (err) {
    soft(err);
    return [];
  }
}
