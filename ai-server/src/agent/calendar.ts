import { tool, type ToolSet } from "ai";
import { z } from "zod";

import { eventsBetween, freeSlots, nextEvent, type CalEvent } from "@/lib/calendar";
import type { RunHere } from "./memory";

// The calendar tools. Read-only, and shared between a device agent and the console
// exactly as the fleet and memory tools are, so the two cannot drift apart.
//
// Everything is formatted in the server's own timezone, which is also the timezone
// the device runs in: the gateway derives what it sends in `welcome` from this same
// clock (posixTz in gateway/index.ts). Saying so in the output matters — a bare
// "10:00" from the wrong zone is the sort of wrong answer that gets believed.

const DAY_MS = 86400_000;

const zone =
  Intl.DateTimeFormat().resolvedOptions().timeZone ||
  // A container with no zone configured reports "UTC" or nothing at all.
  "local time";

function clock(d: Date): string {
  return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

function day(d: Date): string {
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}

function sameDay(a: Date, b: Date): boolean {
  return a.toDateString() === b.toDateString();
}

function describe(e: CalEvent, withDay: boolean): string {
  const when = e.allDay
    ? "all day"
    : sameDay(e.start, e.end) || e.end.getTime() - e.start.getTime() <= DAY_MS
      ? `${clock(e.start)}-${clock(e.end)}`
      : `${clock(e.start)} until ${day(e.end)} ${clock(e.end)}`;
  const where = e.location ? `, ${e.location}` : "";
  return `${withDay ? `${day(e.start)} ` : ""}${when}  ${e.title}${where}`;
}

// "today", "tomorrow", "this week", or an ISO date. Deliberately small: the model is
// good at saying which day it means, and a full natural-language date parser is a
// much bigger surface to get subtly wrong.
function range(spec: string): { from: Date; to: Date; label: string } {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const s = spec.trim().toLowerCase();

  if (s === "" || s === "today") {
    return { from: midnight, to: new Date(midnight.getTime() + DAY_MS), label: "today" };
  }
  if (s === "tomorrow") {
    const start = new Date(midnight.getTime() + DAY_MS);
    return { from: start, to: new Date(start.getTime() + DAY_MS), label: "tomorrow" };
  }
  if (s === "week" || s === "this week" || s === "7 days") {
    return { from: midnight, to: new Date(midnight.getTime() + 7 * DAY_MS), label: "the next 7 days" };
  }
  if (s === "month" || s === "this month" || s === "30 days") {
    return { from: midnight, to: new Date(midnight.getTime() + 30 * DAY_MS), label: "the next 30 days" };
  }
  const asDate = new Date(`${s}T00:00:00`);
  if (!Number.isNaN(asDate.getTime())) {
    return { from: asDate, to: new Date(asDate.getTime() + DAY_MS), label: day(asDate) };
  }
  throw new Error(`cannot tell what "${spec}" means; use today, tomorrow, week, month, or a date like 2026-10-04`);
}

export function calendarTools(opts: { run?: RunHere } = {}): ToolSet {
  const { run } = opts;
  const here = (name: string, args: Record<string, unknown>, body: () => Promise<string>) =>
    run ? run(name, args, body, "read") : body();

  return {
    list_events: tool({
      description:
        "What is on the calendar. Use it for anything about the person's day, week or a particular date. " +
        "Read-only: to add or change an event, tell them to do it in their calendar.",
      inputSchema: z.object({
        when: z
          .string()
          .default("today")
          .describe('"today", "tomorrow", "week", "month", or a date as 2026-10-04'),
      }),
      execute: async ({ when }) =>
        here("list_events", { when }, async () => {
          const { from, to, label } = range(when);
          const events = await eventsBetween(from, to);
          if (!events.length) return `nothing on ${label}`;
          const multiDay = to.getTime() - from.getTime() > DAY_MS;
          return [
            `${events.length} on ${label} (times in ${zone}):`,
            ...events.map((e) => describe(e, multiDay)),
          ].join("\n");
        }),
    }),

    next_event: tool({
      description: "The next thing on the calendar, whenever it is. Use it for 'what's next' and 'am I free now'.",
      inputSchema: z.object({}),
      execute: async () =>
        here("next_event", {}, async () => {
          const e = await nextEvent();
          if (!e) return "nothing else is on the calendar";
          const mins = Math.round((e.start.getTime() - Date.now()) / 60_000);
          const away =
            mins < 60
              ? `in ${mins} min`
              : mins < 24 * 60
                ? `in ${Math.round(mins / 60)}h`
                : `in ${Math.round(mins / (24 * 60))} days`;
          return `${describe(e, true)}  (${away}, ${zone})`;
        }),
    }),

    find_free: tool({
      description:
        "Gaps in the working day with nothing booked. Use it to answer when someone could fit something in. " +
        "All-day entries are ignored, since they mark the day rather than filling it.",
      inputSchema: z.object({
        minutes: z.number().int().min(5).max(600).default(30).describe("how long the gap has to be"),
        within_days: z.number().int().min(1).max(14).default(3).describe("how far ahead to look"),
      }),
      execute: async ({ minutes, within_days }) =>
        here("find_free", { minutes, within_days }, async () => {
          const slots = await freeSlots(minutes, within_days);
          if (!slots.length) return `no gap of ${minutes} min in the next ${within_days} days`;
          return [
            `free for ${minutes}+ min (9-18, ${zone}):`,
            ...slots.slice(0, 12).map((s) => `${day(s.start)} ${clock(s.start)}-${clock(s.end)}`),
          ].join("\n");
        }),
    }),
  };
}

export function calendarGuidance(): string[] {
  return [
    "- list_events(when) / next_event() / find_free(minutes, within_days) read the person's real calendar.",
    "  Use them for anything about their day rather than guessing, and never invent an event.",
    "- The calendar is read-only here. If they want something added or moved, say so plainly.",
  ];
}
