"use client";

import { useState, useTransition } from "react";
import { saveCalendar, testCalendar } from "@/app/actions/settings";
import { Button, Input, Label, Led, Panel } from "@/components/term/primitives";
import { useToast } from "@/components/term/toast";

export function CalendarForm({ configured, preview }: { configured: boolean; preview: string }) {
  // Starts in edit mode only when there is nothing saved. Replacing a url is a
  // deliberate act, so it takes a click — and the box is never pre-filled with the
  // secret, which is the whole point of the server redacting it.
  const [editing, setEditing] = useState(!configured);
  const [url, setUrl] = useState("");
  const [result, setResult] = useState("");
  const [pending, start] = useTransition();
  const toast = useToast();

  function save(value: string) {
    start(async () => {
      const res = await saveCalendar({ icsUrl: value });
      if (!res.ok) return toast(res.error, "err");
      setUrl("");
      setEditing(false);
      setResult("");
      toast(value ? "calendar saved" : "calendar removed");
    });
  }

  function check() {
    start(async () => {
      const res = await testCalendar();
      if (res.ok) {
        setResult(res.detail ?? "the feed parsed");
        toast("the feed reads");
      } else {
        setResult(res.error);
        toast(res.error, "err");
      }
    });
  }

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_400px]">
      <Panel title="calendar feed">
        <div className="grid gap-3">
          <span className="flex items-center gap-2 text-xs">
            <Led on={configured} tone={configured ? "phos" : "err"} />
            <span className={configured ? "text-muted" : "text-err"}>
              {configured ? preview : "no calendar set; the calendar tools are off"}
            </span>
          </span>

          {editing ? (
            <>
              <label className="block">
                <Label hint="kept on the server, never shown again">ICS url</Label>
                <Input
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://calendar.google.com/calendar/ical/…/basic.ics"
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
              <div className="flex gap-2">
                <Button onClick={() => save(url.trim())} disabled={pending || !url.trim()}>
                  save
                </Button>
                {configured && (
                  <Button variant="ghost" onClick={() => setEditing(false)} disabled={pending}>
                    cancel
                  </Button>
                )}
              </div>
            </>
          ) : (
            <div className="flex gap-2">
              <Button onClick={check} disabled={pending}>
                test it
              </Button>
              <Button variant="ghost" onClick={() => setEditing(true)} disabled={pending}>
                replace
              </Button>
              <Button variant="ghost" onClick={() => save("")} disabled={pending}>
                remove
              </Button>
            </div>
          )}

          {result && <p className="border border-line p-2 text-xs text-muted">{result}</p>}
        </div>
      </Panel>

      <Panel title="what this does">
        <div className="space-y-3 text-xs opacity-70">
          <p>
            With a feed set, the agent gets <span className="text-[var(--amber)]">list_events</span>,{" "}
            <span className="text-[var(--amber)]">next_event</span> and{" "}
            <span className="text-[var(--amber)]">find_free</span> — on every device and in this console. So the
            terminal can answer what is on today without inventing it.
          </p>
          <p>
            <span className="text-[var(--amber)]">Read-only.</span> Adding and moving events still happens in the
            calendar itself. Recurring events are expanded properly, and times are given in this server&apos;s
            timezone, which is the one the devices run in.
          </p>
          <p>
            In Google Calendar the url is under <em>Settings → your calendar → Integrate calendar → Secret address
            in iCal format</em>. Treat it like a password: it reads the whole calendar and cannot be scoped.
          </p>
          <p className="text-[11px] text-amber-faint">
            The feed is cached for five minutes, so a change made in the calendar can take that long to show up.
          </p>
        </div>
      </Panel>
    </div>
  );
}
