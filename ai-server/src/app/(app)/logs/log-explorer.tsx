"use client";

import { AnimatePresence } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { EventLine } from "@/components/term/event-line";
import { Button, EmptyState, Input, Label, Panel, Select } from "@/components/term/primitives";
import { useLive } from "@/hooks/use-live";
import { cn } from "@/lib/cn";
import { EVENT_TYPES, LEVELS, type Device, type EventRow, type EventType, type Level } from "@/lib/types";

type Filter = { device: string; types: EventType[]; levels: Level[]; q: string };

function matches(e: EventRow, f: Filter) {
  if (f.device && e.device_id !== f.device) return false;
  if (f.types.length && !f.types.includes(e.type)) return false;
  if (f.levels.length && !f.levels.includes(e.level)) return false;
  if (f.q && !e.summary.toLowerCase().includes(f.q.toLowerCase())) return false;
  return true;
}

function toQuery(f: Filter, before?: number) {
  const p = new URLSearchParams();
  if (f.device) p.set("device", f.device);
  if (f.types.length) p.set("type", f.types.join(","));
  if (f.levels.length) p.set("level", f.levels.join(","));
  if (f.q) p.set("q", f.q);
  if (before) p.set("before", String(before));
  p.set("limit", "200");
  return p.toString();
}

export function LogExplorer({ initial, devices, initialDevice }: { initial: EventRow[]; devices: Device[]; initialDevice?: string }) {
  const [filter, setFilter] = useState<Filter>({ device: initialDevice ?? "", types: [], levels: [], q: "" });
  const [search, setSearch] = useState("");
  const [events, setEvents] = useState(initial);
  const [fresh, setFresh] = useState<Set<number>>(new Set());
  const [tail, setTail] = useState(true);
  const [hover, setHover] = useState(false);
  const [loading, setLoading] = useState(false);
  const [exhausted, setExhausted] = useState(initial.length < 200);
  const held = useRef<EventRow[]>([]);
  const [heldCount, setHeldCount] = useState(0);
  const first = useRef(true);

  // Debounce the search box into the filter.
  useEffect(() => {
    const id = setTimeout(() => setFilter((f) => (f.q === search ? f : { ...f, q: search })), 300);
    return () => clearTimeout(id);
  }, [search]);

  // Refetch from the server whenever the filter changes.
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const ctrl = new AbortController();
    setLoading(true);
    fetch(`/api/events?${toQuery(filter)}`, { signal: ctrl.signal })
      .then((r) => r.json())
      .then((d: { events: EventRow[] }) => {
        setEvents(d.events);
        setFresh(new Set());
        setExhausted(d.events.length < 200);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
    return () => ctrl.abort();
  }, [filter]);

  function add(incoming: EventRow[]) {
    setEvents((ev) => [...incoming, ...ev].slice(0, 2000));
    setFresh((f) => new Set([...f, ...incoming.map((e) => e.id)]));
  }

  function release() {
    setHover(false);
    if (held.current.length) add(held.current);
    held.current = [];
    setHeldCount(0);
  }

  useLive((msg) => {
    if (msg.kind !== "event" || !tail || !matches(msg.event, filter)) return;
    if (hover) {
      held.current.unshift(msg.event);
      setHeldCount(held.current.length);
      return;
    }
    add([msg.event]);
  });

  async function older() {
    const last = events.at(-1);
    if (!last) return;
    setLoading(true);
    const d: { events: EventRow[] } = await fetch(`/api/events?${toQuery(filter, last.id)}`).then((r) => r.json());
    setEvents((ev) => [...ev, ...d.events]);
    setExhausted(d.events.length < 200);
    setLoading(false);
  }

  function exportJson() {
    const blob = new Blob([JSON.stringify(events, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `ai-term-logs-${new Date().toISOString().slice(0, 19).replace(/:/g, "")}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const active = filter.device || filter.types.length || filter.levels.length || filter.q;

  return (
    <div className="grid gap-4 xl:grid-cols-[260px_minmax(0,1fr)]">
      <Panel title="filter" className="self-start xl:sticky xl:top-16">
        <div className="space-y-4">
          <label className="block">
            <Label>grep</Label>
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="text in summary…" />
          </label>
          <label className="block">
            <Label>device</Label>
            <Select value={filter.device} onChange={(e) => setFilter((f) => ({ ...f, device: e.target.value }))}>
              <option value="">all devices</option>
              {devices.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </Select>
          </label>
          <div>
            <Label>type</Label>
            <Chips options={EVENT_TYPES} selected={filter.types} onToggle={(t) => setFilter((f) => ({ ...f, types: toggle(f.types, t) }))} />
          </div>
          <div>
            <Label>level</Label>
            <Chips options={LEVELS} selected={filter.levels} onToggle={(l) => setFilter((f) => ({ ...f, levels: toggle(f.levels, l) }))} />
          </div>
          {active ? (
            <button
              onClick={() => {
                setSearch("");
                setFilter({ device: "", types: [], levels: [], q: "" });
              }}
              className="cursor-pointer text-[11px] text-muted hover:text-err"
            >
              × clear filters
            </button>
          ) : null}
        </div>
      </Panel>

      <Panel
        title={
          <>
            stream <span className="text-amber-faint">{events.length} lines</span>
          </>
        }
        bodyClassName="p-0"
        actions={
          <>
            <button
              onClick={() => setTail((t) => !t)}
              className={cn("flex cursor-pointer items-center gap-1.5 text-[11px] uppercase tracking-[0.14em]", tail ? "text-phos" : "text-muted")}
            >
              <span className={cn("inline-block size-2 rounded-full", tail ? "animate-breathe bg-phos text-phos" : "bg-amber-faint")} />
              {tail ? "live tail" : "tail off"}
            </button>
            <Button size="sm" onClick={exportJson} disabled={!events.length}>
              export
            </Button>
          </>
        }
      >
        <div className="relative" onMouseEnter={() => setHover(true)} onMouseLeave={release}>
          {loading && <div className="absolute inset-x-0 top-0 h-px animate-pulse bg-amber shadow-[0_0_10px_var(--amber)]" />}
          {hover && tail && (
            <span className="pointer-events-none absolute right-3 top-2 z-10 border border-amber/40 bg-panel px-1.5 py-0.5 text-[10px] uppercase tracking-[0.16em] text-amber">
              ❚❚ held{heldCount ? ` +${heldCount}` : ""}
            </span>
          )}
          <ul className={cn("h-[calc(100dvh-220px)] min-h-[400px] overflow-y-auto py-1 transition-opacity", loading && "opacity-60")}>
            {events.length === 0 && !loading && (
              <li>
                <EmptyState title={active ? "no lines match" : "log is empty"}>{active ? "Loosen the filter or wait for new traffic." : "Connect a device to start the stream."}</EmptyState>
              </li>
            )}
            <AnimatePresence initial={false}>
              {events.map((e) => (
                <EventLine key={e.id} event={e} fresh={fresh.has(e.id)} dense />
              ))}
            </AnimatePresence>
            {events.length > 0 && (
              <li className="py-3 text-center">
                {exhausted ? (
                  <span className="text-[11px] text-amber-faint">── end of log ──</span>
                ) : (
                  <Button size="sm" onClick={older} disabled={loading}>
                    {loading ? "loading…" : "load older"}
                  </Button>
                )}
              </li>
            )}
          </ul>
        </div>
      </Panel>
    </div>
  );
}

function Chips<T extends string>({ options, selected, onToggle }: { options: readonly T[]; selected: T[]; onToggle: (v: T) => void }) {
  return (
    <div className="flex flex-wrap gap-1">
      {options.map((o) => {
        const on = selected.includes(o);
        return (
          <button
            key={o}
            onClick={() => onToggle(o)}
            className={cn(
              "cursor-pointer border px-1.5 py-0.5 text-[10px] uppercase tracking-[0.1em] transition-all active:scale-95",
              on ? "border-amber bg-amber text-bg" : "border-line text-muted hover:border-amber/60 hover:text-fg",
            )}
          >
            {o}
          </button>
        );
      })}
    </div>
  );
}
