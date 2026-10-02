"use client";

import { motion } from "motion/react";
import Link from "next/link";
import { cn } from "@/lib/cn";
import type { EventRow } from "@/lib/types";
import { LocalTime, Typewriter } from "./motion";

const TYPE_TONE: Record<EventRow["type"], string> = {
  connect: "text-phos",
  disconnect: "text-muted",
  chat: "text-amber",
  command: "text-info",
  action: "text-info",
  log: "text-fg/70",
  error: "text-err",
};

const LEVEL_TONE: Record<EventRow["level"], string> = {
  debug: "text-amber-faint",
  info: "text-muted",
  warn: "text-warn",
  error: "text-err glow-err",
};

// One row of a log stream. `fresh` rows type themselves in and glow, then decay.
export function EventLine({ event, fresh, showDevice = true, dense }: { event: EventRow; fresh?: boolean; showDevice?: boolean; dense?: boolean }) {
  return (
    <motion.li
      layout="position"
      initial={fresh ? { opacity: 0, x: -8 } : false}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.2 }}
      className={cn(
        "group/line grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-3 border-l-2 border-transparent px-2 transition-colors hover:border-amber hover:bg-amber/[0.04] sm:grid-cols-[auto_auto_auto_minmax(0,1fr)]",
        dense ? "py-0.5" : "py-1",
        fresh && "decay",
        event.level === "error" && "border-err/40",
      )}
    >
      <LocalTime iso={event.created_at} className="text-[11px] tabular-nums text-amber-faint" />
      <span className={cn("hidden w-14 text-[11px] uppercase sm:inline", LEVEL_TONE[event.level])}>{event.level}</span>
      {showDevice ? (
        <span className="hidden max-w-36 truncate text-[11px] sm:inline">
          {event.device_id ? (
            <Link href={`/devices/${event.device_id}`} className="text-amber-dim hover:text-amber hover:underline">
              [{event.device?.name ?? event.device_id.slice(0, 8)}]
            </Link>
          ) : (
            <span className="text-amber-faint">[server]</span>
          )}
        </span>
      ) : (
        <span className="hidden sm:inline" />
      )}
      <span className="min-w-0 break-words text-xs">
        <span className={cn("mr-2 uppercase", TYPE_TONE[event.type])}>{event.type}</span>
        <span className="text-fg/90">{fresh ? <Typewriter text={event.summary} speed={8} /> : event.summary}</span>
      </span>
    </motion.li>
  );
}
