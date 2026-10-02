import { env } from "../env";
import { db, must } from "../supabase";
import type { CalendarSettings, LlmSettings } from "../types";

export const DEFAULT_SYSTEM_PROMPT = `You are AI-TERM, the assistant running behind a small ESP32-S3 terminal.
Replies are shown on a tiny screen or spoken aloud, so keep them short, plain text, no markdown.`;

export function defaultLlmSettings(): LlmSettings {
  return {
    model: env().DEFAULT_MODEL,
    temperature: null,
    maxOutputTokens: 1024,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
  };
}

export async function getLlmSettings(): Promise<LlmSettings> {
  const row = must(await db().from("settings").select("value").eq("key", "llm").maybeSingle()) as {
    value: Partial<LlmSettings>;
  } | null;
  return { ...defaultLlmSettings(), ...(row?.value ?? {}) };
}

export async function saveLlmSettings(value: LlmSettings) {
  must(
    await db()
      .from("settings")
      .upsert({ key: "llm", value, updated_at: new Date().toISOString() })
      .select("key")
      .single(),
  );
}

// The calendar's private ICS url. In the settings table rather than the env because
// it is the kind of thing that gets changed — a new calendar, a rotated url — and
// changing it here does not need a rebuild and a restart.
export async function getCalendarSettings(): Promise<CalendarSettings> {
  const row = must(await db().from("settings").select("value").eq("key", "calendar").maybeSingle()) as {
    value: Partial<CalendarSettings>;
  } | null;
  return { icsUrl: "", ...(row?.value ?? {}) };
}

export async function saveCalendarSettings(value: CalendarSettings) {
  must(
    await db()
      .from("settings")
      .upsert({ key: "calendar", value, updated_at: new Date().toISOString() })
      .select("key")
      .single(),
  );
}
