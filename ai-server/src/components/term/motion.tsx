"use client";

import { animate, motion, useInView, useMotionValue, useTransform } from "motion/react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { cn } from "@/lib/cn";
import { ago, compact } from "@/lib/format";

/* Numbers that roll up from zero when they scroll into view, and roll to new values. */
export function CountUp({ value, format = "compact", className }: { value: number; format?: "compact" | "plain"; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true });
  const mv = useMotionValue(0);
  const text = useTransform(mv, (v) => (format === "compact" ? compact(Math.round(v)) : Math.round(v).toLocaleString()));

  useEffect(() => {
    if (!inView) return;
    const controls = animate(mv, value, { duration: 1.1, ease: [0.16, 1, 0.3, 1] });
    return () => controls.stop();
  }, [inView, value, mv]);

  return <motion.span ref={ref} className={cn("tabular-nums", className)}>{text}</motion.span>;
}

/* Reveals text a character at a time, like a slow serial line. */
export function Typewriter({ text, speed = 14, className, onDone }: { text: string; speed?: number; className?: string; onDone?: () => void }) {
  // Progress is keyed by text, so a new string starts from zero without a reset effect.
  const [progress, setProgress] = useState({ text, n: 0 });
  const n = progress.text === text ? progress.n : 0;
  const done = useRef(onDone);
  useEffect(() => {
    done.current = onDone;
  });

  useEffect(() => {
    if (!text) return;
    let i = 0;
    const id = setInterval(() => {
      i += Math.max(1, Math.round(text.length / 120));
      setProgress({ text, n: Math.min(i, text.length) });
      if (i >= text.length) {
        clearInterval(id);
        done.current?.();
      }
    }, speed);
    return () => clearInterval(id);
  }, [text, speed]);

  return <span className={className}>{text.slice(0, n)}</span>;
}

/* ▁▂▃▅▇ from a series. */
const BLOCKS = "▁▂▃▄▅▆▇█";
export function AsciiSpark({ data, className }: { data: number[]; className?: string }) {
  const max = Math.max(1, ...data);
  return (
    <span aria-hidden className={cn("font-mono tracking-[-0.05em]", className)}>
      {data.map((v, i) => (
        <motion.span
          key={i}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: i * 0.025 }}
          className="inline-block"
        >
          {v === 0 ? "·" : BLOCKS[Math.min(BLOCKS.length - 1, Math.floor((v / max) * (BLOCKS.length - 1)))]}
        </motion.span>
      ))}
    </span>
  );
}

/* ▓▓▓▓▓░░░ meter that fills on mount. */
export function AsciiBar({ value, width = 16, className, tone = "amber" }: { value: number; width?: number; className?: string; tone?: "amber" | "phos" | "err" }) {
  const [filled, setFilled] = useState(0);
  const target = Math.round(Math.max(0, Math.min(1, value)) * width);
  useEffect(() => {
    let i = 0;
    const id = setInterval(() => {
      i++;
      setFilled(Math.min(i, target));
      if (i >= target) clearInterval(id);
    }, 28);
    return () => clearInterval(id);
  }, [target]);
  const color = { amber: "text-amber", phos: "text-phos", err: "text-err" }[tone];
  return (
    <span aria-hidden className={cn("font-mono", className)}>
      <span className={color}>{"▓".repeat(filled)}</span>
      <span className="text-amber-faint">{"░".repeat(width - filled)}</span>
    </span>
  );
}

/* A shared 1s ticker, so every relative time on the page updates together. */
const listeners = new Set<() => void>();
let now = Date.now();
let timer: ReturnType<typeof setInterval> | undefined;
function subscribeNow(cb: () => void) {
  listeners.add(cb);
  timer ??= setInterval(() => {
    now = Date.now();
    listeners.forEach((l) => l());
  }, 1000);
  return () => {
    listeners.delete(cb);
    if (!listeners.size && timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}
export function useNow() {
  return useSyncExternalStore(subscribeNow, () => now, () => 0);
}

export function TimeAgo({ iso, className }: { iso: string | null | undefined; className?: string }) {
  const t = useNow();
  // Locale formatting differs between server and browser, so it waits for hydration (t !== 0).
  return (
    <time dateTime={iso ?? undefined} title={iso && t !== 0 ? new Date(iso).toLocaleString() : undefined} className={className}>
      {t === 0 ? "…" : ago(iso, t)}
    </time>
  );
}

export function LocalTime({ iso, className, withDate }: { iso: string; className?: string; withDate?: boolean }) {
  const t = useNow();
  if (t === 0) return <time className={className}>--:--:--</time>;
  const d = new Date(iso);
  const time = d.toLocaleTimeString([], { hour12: false });
  const date = d.toLocaleDateString([], { month: "short", day: "2-digit" });
  return (
    <time dateTime={iso} className={className}>
      {withDate ? `${date} ${time}` : time}
    </time>
  );
}
