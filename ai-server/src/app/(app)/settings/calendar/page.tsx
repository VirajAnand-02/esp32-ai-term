import type { Metadata } from "next";
import { LinkDown, load } from "@/components/term/link-down";
import { getCalendarSettings } from "@/lib/db/settings";
import { CalendarForm } from "./calendar-form";

export const metadata: Metadata = { title: "calendar settings" };

// A private ICS url is a secret: anyone holding it can read the calendar. So the
// full value never leaves the server — the page sends back only enough to recognise
// which feed is configured.
function redact(url: string): string {
  if (!url) return "";
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").filter(Boolean).pop() ?? "";
    return `${u.origin}/…/${last}`;
  } catch {
    return "a url that will not parse";
  }
}

export default async function CalendarSettingsPage() {
  const res = await load(async () => await getCalendarSettings());
  if (!res.ok) return <LinkDown error={res.error} />;
  return <CalendarForm configured={Boolean(res.data.icsUrl)} preview={redact(res.data.icsUrl)} />;
}
