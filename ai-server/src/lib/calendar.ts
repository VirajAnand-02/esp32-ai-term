import { async as ical } from "node-ical";

import { getCalendarSettings } from "./db/settings";

// The calendar, read over ICS.
//
// Read-only on purpose. A private ICS url is a secret the person already has — no
// OAuth flow, no consent screen, no token refresh, no per-user token storage that
// this single-tenant server has nowhere to put. It is enough to answer the questions
// actually asked of a terminal on a desk: what is on today, what is next, when am I
// free. Creating an event is still done wherever the calendar really lives.
//
// node-ical rather than a hand-rolled parser: real feeds fold long lines, carry
// VTIMEZONE blocks, and express a standup as an RRULE. A naive parser does not fail
// on those, it quietly gets the recurring events wrong, which is worse than not
// having the feature.

export type CalEvent = {
  title: string;
  start: Date;
  end: Date;
  allDay: boolean;
  location: string;
  recurring: boolean;
};

// These feeds are large and slow — a few hundred KB is normal — and one turn may ask
// twice. In-process like everything else here (see lib/live.ts on why that is fine
// at one replica).
const TTL_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 15_000;
// A year of expansion is plenty for "what's next" and stops a daily event with no
// UNTIL from being expanded forever.
const HORIZON_DAYS = 370;

let cache: { at: number; url: string; events: CalEvent[] } | null = null;

export async function calendarAvailable(): Promise<boolean> {
  return Boolean((await getCalendarSettings()).icsUrl);
}

function text(v: unknown): string {
  if (typeof v === "string") return v;
  // node-ical hands back { val } for some properties, and undefined for absent ones.
  if (v && typeof v === "object" && "val" in v) return String((v as { val: unknown }).val ?? "");
  return "";
}

// An all-day event is dated, not timed: node-ical marks it with dateOnly, and its
// end is exclusive (a one-day event ends on the following midnight).
function isAllDay(start: Date): boolean {
  return (start as Date & { dateOnly?: boolean }).dateOnly === true;
}

function expand(component: Record<string, unknown>, from: Date, to: Date, out: CalEvent[]) {
  const start = component.start as Date | undefined;
  const end = (component.end as Date | undefined) ?? start;
  if (!start || !end) return;

  const title = text(component.summary) || "(untitled)";
  const location = text(component.location);
  const allDay = isAllDay(start);
  const lengthMs = Math.max(0, end.getTime() - start.getTime());
  const rrule = component.rrule as { between?: (a: Date, b: Date, inc?: boolean) => Date[] } | undefined;

  if (!rrule?.between) {
    if (end >= from && start <= to) out.push({ title, start, end, allDay, location, recurring: false });
    return;
  }

  // Recurrences, minus the ones deleted or moved. node-ical reports both: exdate
  // holds the cancelled occurrences, recurrences the ones edited individually.
  const exdate = (component.exdate ?? {}) as Record<string, Date>;
  const edited = (component.recurrences ?? {}) as Record<string, Record<string, unknown>>;
  const cancelled = new Set(Object.keys(exdate));

  for (const at of rrule.between(from, to, true)) {
    const key = at.toISOString().slice(0, 10);
    if (cancelled.has(key) || cancelled.has(at.toISOString())) continue;
    const override = edited[key];
    if (override) {
      // An edited occurrence carries its own time and title, so it is a plain event.
      expand(override, from, to, out);
      continue;
    }
    out.push({ title, start: at, end: new Date(at.getTime() + lengthMs), allDay, location, recurring: true });
  }

  // An individually edited occurrence can be moved outside the recurrence window, so
  // the overrides are swept separately as well.
  for (const [key, override] of Object.entries(edited)) {
    const at = (override.start as Date | undefined) ?? null;
    if (!at || rrule.between(from, to, true).some((d) => d.toISOString().slice(0, 10) === key)) continue;
    expand(override, from, to, out);
  }
}

async function load(): Promise<CalEvent[]> {
  const { icsUrl } = await getCalendarSettings();
  if (!icsUrl) throw new Error("no calendar is set up; add the ICS url in Settings");

  if (cache && cache.url === icsUrl && Date.now() - cache.at < TTL_MS) return cache.events;

  const res = await fetch(icsUrl, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { accept: "text/calendar, text/plain, */*" },
  });
  if (!res.ok) throw new Error(`the calendar feed answered ${res.status}`);
  const body = await res.text();
  if (!body.includes("BEGIN:VCALENDAR")) throw new Error("that url did not return a calendar");

  const parsed = await ical.parseICS(body);
  const now = new Date();
  const from = new Date(now.getTime() - 2 * 86400_000); // yesterday, so "today" is whole
  const to = new Date(now.getTime() + HORIZON_DAYS * 86400_000);

  const events: CalEvent[] = [];
  for (const component of Object.values(parsed)) {
    const c = component as Record<string, unknown>;
    if (c.type !== "VEVENT") continue;
    expand(c, from, to, events);
  }
  events.sort((a, b) => a.start.getTime() - b.start.getTime());

  cache = { at: Date.now(), url: icsUrl, events };
  return events;
}

export async function eventsBetween(from: Date, to: Date): Promise<CalEvent[]> {
  const all = await load();
  return all.filter((e) => e.end > from && e.start < to);
}

export async function nextEvent(after = new Date()): Promise<CalEvent | null> {
  const all = await load();
  return all.find((e) => e.start > after) ?? null;
}

// Gaps in the working day with nothing booked in them. Only ever asked about the
// near future, so the search is bounded by days rather than by a date range.
export async function freeSlots(
  minMinutes: number,
  withinDays: number,
  dayStartHour = 9,
  dayEndHour = 18,
): Promise<{ start: Date; end: Date }[]> {
  const now = new Date();
  const until = new Date(now.getTime() + withinDays * 86400_000);
  // All-day events are excluded: they mark the day, they do not occupy the hours,
  // and treating a birthday as a full-day meeting makes every day look booked.
  const busy = (await eventsBetween(now, until))
    .filter((e) => !e.allDay)
    .map((e) => ({ start: e.start, end: e.end }))
    .sort((a, b) => a.start.getTime() - b.start.getTime());

  const slots: { start: Date; end: Date }[] = [];
  for (let day = 0; day < withinDays; day++) {
    const d = new Date(now.getTime() + day * 86400_000);
    const open = new Date(d);
    open.setHours(dayStartHour, 0, 0, 0);
    const close = new Date(d);
    close.setHours(dayEndHour, 0, 0, 0);

    let cursor = open > now ? open : now;
    for (const b of busy) {
      if (b.end <= cursor || b.start >= close) continue;
      if (b.start.getTime() - cursor.getTime() >= minMinutes * 60_000) {
        slots.push({ start: new Date(cursor), end: new Date(b.start) });
      }
      if (b.end > cursor) cursor = b.end;
    }
    if (close.getTime() - cursor.getTime() >= minMinutes * 60_000 && cursor < close) {
      slots.push({ start: new Date(cursor), end: new Date(close) });
    }
  }
  return slots;
}
