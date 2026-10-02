"use client";

import { AnimatePresence } from "motion/react";
import { useRef, useState } from "react";
import { useLive } from "@/hooks/use-live";
import { cn } from "@/lib/cn";
import type { EventRow } from "@/lib/types";
import { EventLine } from "./event-line";
import { EmptyState } from "./primitives";

// Newest-first event stream. Hovering pauses it so a line doesn't move while you read it.
export function LiveFeed({
  initial,
  deviceId,
  height = "h-[420px]",
  max = 200,
}: {
  initial: EventRow[];
  deviceId?: string;
  height?: string;
  max?: number;
}) {
  const [events, setEvents] = useState(initial);
  const [fresh, setFresh] = useState<Set<number>>(new Set());
  const [paused, setPaused] = useState(false);
  const [buffered, setBuffered] = useState(0);
  const buffer = useRef<EventRow[]>([]);

  function flush(extra: EventRow[] = []) {
    const incoming = [...extra, ...buffer.current];
    buffer.current = [];
    setBuffered(0);
    if (!incoming.length) return;
    setEvents((ev) => [...incoming, ...ev].slice(0, max));
    setFresh((f) => new Set([...f, ...incoming.map((e) => e.id)]));
  }

  useLive((msg) => {
    if (msg.kind !== "event") return;
    if (deviceId && msg.event.device_id !== deviceId) return;
    if (paused) {
      buffer.current.unshift(msg.event);
      setBuffered(buffer.current.length);
    } else flush([msg.event]);
  });

  return (
    <div
      className="relative"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => {
        setPaused(false);
        flush();
      }}
    >
      <div className={cn("pointer-events-none absolute right-3 top-2 z-10 text-[10px] uppercase tracking-[0.16em] transition-opacity", paused ? "opacity-100" : "opacity-0")}>
        <span className="border border-amber/40 bg-panel px-1.5 py-0.5 text-amber">❚❚ paused{buffered ? ` +${buffered}` : ""}</span>
      </div>
      <ul className={cn("overflow-y-auto py-1", height)}>
        {events.length === 0 && (
          <li>
            <EmptyState title="silence on the wire">Events appear here the moment a device connects.</EmptyState>
          </li>
        )}
        <AnimatePresence initial={false}>
          {events.map((e) => (
            <EventLine key={e.id} event={e} fresh={fresh.has(e.id)} showDevice={!deviceId} />
          ))}
        </AnimatePresence>
      </ul>
    </div>
  );
}
