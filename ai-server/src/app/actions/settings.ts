"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { createMemory, deleteMemory, setMemoryEnabled } from "@/lib/db/memories";
import { saveCalendarSettings, saveLlmSettings } from "@/lib/db/settings";

type Result = { ok: true } | { ok: false; error: string };

function fail(err: unknown): Result {
  return { ok: false, error: err instanceof z.ZodError ? (err.issues[0]?.message ?? "invalid input") : (err as Error).message };
}

const llm = z.object({
  model: z.string().regex(/^[a-z]+:.+$/, "model must look like provider:model-id"),
  temperature: z.number().min(0).max(2).nullable(),
  maxOutputTokens: z.number().int().min(16).max(32768),
  systemPrompt: z.string().max(8000),
});

export async function saveLlm(input: z.input<typeof llm>): Promise<Result> {
  await requireAdmin();
  try {
    await saveLlmSettings(llm.parse(input));
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

const calendar = z.object({
  // Empty turns the calendar tools off again, which is the only way to remove one.
  icsUrl: z
    .string()
    .trim()
    .max(2000)
    .refine((v) => v === "" || /^https?:\/\//.test(v), "the ICS url has to start with http:// or https://"),
});

export async function saveCalendar(input: z.input<typeof calendar>): Promise<Result> {
  await requireAdmin();
  try {
    await saveCalendarSettings(calendar.parse(input));
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

// Checks the url actually returns a calendar before it is relied on, and says what
// it found. Pasting a web page's url instead of the ICS one is the obvious mistake,
// and it would otherwise only show up as the agent having no events.
export async function testCalendar(): Promise<Result & { detail?: string }> {
  await requireAdmin();
  try {
    const { eventsBetween } = await import("@/lib/calendar");
    const now = new Date();
    const soon = new Date(now.getTime() + 7 * 86400_000);
    const events = await eventsBetween(now, soon);
    const next = events[0];
    return {
      ok: true,
      detail: next
        ? `${events.length} in the next 7 days; next is "${next.title}"`
        : "the feed parsed, but there is nothing in the next 7 days",
    };
  } catch (err) {
    return fail(err);
  }
}

const memory = z.object({
  content: z.string().trim().min(1, "memory is empty").max(2000),
  tags: z.array(z.string().trim().min(1).max(24)).max(8),
  device_id: z.uuid().nullable(),
});

export async function addMemory(input: z.input<typeof memory>): Promise<Result> {
  await requireAdmin();
  try {
    await createMemory(memory.parse(input));
    revalidatePath("/settings/memories");
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

export async function toggleMemory(id: string, enabled: boolean): Promise<Result> {
  await requireAdmin();
  try {
    await setMemoryEnabled(id, enabled);
    revalidatePath("/settings/memories");
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

export async function removeMemory(id: string): Promise<Result> {
  await requireAdmin();
  try {
    await deleteMemory(id);
    revalidatePath("/settings/memories");
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}
