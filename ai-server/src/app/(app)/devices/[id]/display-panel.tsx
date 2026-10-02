"use client";

import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useState } from "react";
import { Button, EmptyState, Input, Label, Panel, Select, Tag } from "@/components/term/primitives";
import { useToast } from "@/components/term/toast";
import { cn } from "@/lib/cn";

// Drives the device's display tools directly, with no model in the loop, so the
// panel can be checked on its own. Everything here maps to one firmware tool.

type Snapshot = { online: boolean; tools: { name: string; risk: string; description: string }[] };

type Tone = "amber" | "green" | "red" | "blue" | "dim";
type Pattern = "bars" | "grid" | "gradient";

const TONES: Record<Tone, string> = {
  amber: "#f3c56b",
  green: "#39ff7a",
  red: "#ff4d3d",
  blue: "#7ad7ff",
  dim: "#9a7a44",
};

const SWATCHES = ["#ff4d3d", "#ff8800", "#f3c56b", "#39ff7a", "#7ad7ff", "#7a4dff", "#ff4dc4", "#ffffff", "#000000"];

const PATTERN_PREVIEW: Record<Pattern, string> = {
  bars: "linear-gradient(90deg,#fff 0 12.5%,#ff0 0 25%,#0ff 0 37.5%,#0f0 0 50%,#f0f 0 62.5%,#f00 0 75%,#00f 0 87.5%,#000 0)",
  grid: "repeating-linear-gradient(#9a7a44 0 1px,transparent 1px 10px),repeating-linear-gradient(90deg,#9a7a44 0 1px,transparent 1px 10px),#0b0906",
  gradient: "linear-gradient(#000,#fff)",
};

type Call = { at: number; name: string; ok: boolean; detail: string };

export function DisplayPanel({ deviceId, deviceName, online }: { deviceId: string; deviceName: string; online: boolean }) {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [log, setLog] = useState<Call[]>([]);

  const [title, setTitle] = useState("ai-term");
  const [body, setBody] = useState("hello from the dashboard");
  const [tone, setTone] = useState<Tone>("amber");
  const [size, setSize] = useState(1);
  const [fill, setFill] = useState("#39ff7a");
  const [backlight, setBacklight] = useState(100);
  const toast = useToast();

  useEffect(() => {
    let cancelled = false;
    void fetch(`/api/devices/${deviceId}/live`, { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<Snapshot>) : null))
      .then((data) => {
        if (data && !cancelled) setSnap(data);
      });
    return () => {
      cancelled = true;
    };
  }, [deviceId]);

  const run = useCallback(
    async (name: string, args: Record<string, unknown>) => {
      setBusy(name);
      try {
        const res = await fetch(`/api/devices/${deviceId}/tool`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, args }),
        });
        const data = (await res.json().catch(() => ({}))) as { ok?: boolean; output?: string; error?: string };
        const ok = res.ok && Boolean(data.ok);
        setLog((xs) => [{ at: Date.now(), name, ok, detail: (ok ? data.output : data.error) ?? "" }, ...xs].slice(0, 12));
        if (!ok) toast(data.error ?? "the call failed", "err");
      } finally {
        setBusy(null);
      }
    },
    [deviceId, toast],
  );

  const has = (name: string) => Boolean(snap?.tools.some((t) => t.name === name));
  const wired = Boolean(snap?.online) && online && has("display_text");

  if (!snap) {
    return (
      <Panel title="display">
        <p className="py-8 text-center text-xs text-amber-dim">
          reading the device<span className="animate-blink">_</span>
        </p>
      </Panel>
    );
  }

  if (!wired) {
    return (
      <Panel title="display">
        <EmptyState title={online ? "no panel on this device" : `${deviceName} is offline`}>
          {online
            ? "This device advertises no display tools. Fit an ST7789 panel and flash firmware with display support."
            : "Bring the device online to drive its panel."}
        </EmptyState>
      </Panel>
    );
  }

  const disabled = busy !== null;

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
      <div className="grid min-w-0 content-start gap-4">
        <Panel
          title="text"
          actions={<span className="text-[10px] uppercase tracking-[0.14em] text-amber-faint">display_text</span>}
        >
          <div className="grid gap-3">
            <div className="grid gap-3 sm:grid-cols-[1fr_120px_90px]">
              <div>
                <Label hint="drawn in the accent colour">title</Label>
                <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="optional" maxLength={28} />
              </div>
              <div>
                <Label>colour</Label>
                <Select value={tone} onChange={(e) => setTone(e.target.value as Tone)}>
                  {Object.keys(TONES).map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </Select>
              </div>
              <div>
                <Label>size</Label>
                <Select value={size} onChange={(e) => setSize(Number(e.target.value))}>
                  {[1, 2, 3].map((s) => (
                    <option key={s} value={s}>
                      {s}×
                    </option>
                  ))}
                </Select>
              </div>
            </div>
            <div>
              <Label hint={`${body.length} chars · ~${Math.floor(28 / size)} per line`}>body</Label>
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={3}
                className="w-full resize-none border border-line bg-bg-2/60 px-2.5 py-1.5 text-[13px] text-amber outline-none placeholder:text-amber-faint focus:border-amber/50"
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="primary"
                size="sm"
                disabled={disabled || !body.trim()}
                onClick={() => run("display_text", { text: body, title: title || undefined, color: tone, size })}
              >
                {busy === "display_text" ? "drawing…" : "draw on panel"}
              </Button>
              <Button size="sm" disabled={disabled} onClick={() => run("display_text", { text: "", title: "", color: tone, size: 1 })}>
                clear
              </Button>
            </div>
          </div>
        </Panel>

        <Panel title="test patterns" actions={<span className="text-[10px] uppercase tracking-[0.14em] text-amber-faint">display_pattern</span>}>
          <div className="grid gap-3 sm:grid-cols-3">
            {(Object.keys(PATTERN_PREVIEW) as Pattern[]).map((p) => (
              <button
                key={p}
                disabled={disabled || !has("display_pattern")}
                onClick={() => run("display_pattern", { pattern: p })}
                className="group cursor-pointer border border-line p-2 text-left transition-colors hover:border-amber/60 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <span className="block aspect-square w-full border border-line/60" style={{ background: PATTERN_PREVIEW[p] }} />
                <span className="mt-1.5 block text-xs text-fg group-hover:text-amber">{p}</span>
              </button>
            ))}
          </div>
          <p className="mt-3 text-[11px] text-amber-faint">
            Colour bars check the wiring and the byte order; the grid checks the edges and geometry; the gradient shows banding.
          </p>
        </Panel>
      </div>

      <div className="grid min-w-0 content-start gap-4">
        <Panel title="fill" className="min-w-0" actions={<span className="text-[10px] uppercase tracking-[0.14em] text-amber-faint">display_fill</span>}>
          <div className="flex flex-wrap gap-1.5">
            {SWATCHES.map((c) => (
              <button
                key={c}
                disabled={disabled || !has("display_fill")}
                onClick={() => {
                  setFill(c);
                  void run("display_fill", { color: c });
                }}
                title={c}
                style={{ background: c }}
                className={cn(
                  "size-7 cursor-pointer border transition-transform hover:scale-110 disabled:cursor-not-allowed disabled:opacity-50",
                  fill === c ? "border-amber" : "border-line",
                )}
              />
            ))}
          </div>
          <div className="mt-3 flex items-center gap-2">
            <Input value={fill} onChange={(e) => setFill(e.target.value)} className="flex-1" placeholder="#ff8800" />
            <Button size="sm" disabled={disabled || !has("display_fill")} onClick={() => run("display_fill", { color: fill })}>
              fill
            </Button>
          </div>
        </Panel>

        <Panel title="backlight" className="min-w-0" actions={<span className="text-[10px] uppercase tracking-[0.14em] text-amber-faint">display_backlight</span>}>
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={backlight}
            onChange={(e) => setBacklight(Number(e.target.value))}
            onPointerUp={() => run("display_backlight", { percent: backlight })}
            onKeyUp={() => run("display_backlight", { percent: backlight })}
            disabled={disabled || !has("display_backlight")}
            className="w-full accent-[color:var(--color-amber)]"
          />
          <div className="mt-1 flex items-center justify-between text-xs">
            <span className="text-amber-faint">brightness</span>
            <span className="text-amber tabular-nums">{backlight}%</span>
          </div>
          <div className="mt-2 flex gap-1.5">
            {[0, 25, 50, 100].map((p) => (
              <Button
                key={p}
                size="sm"
                disabled={disabled || !has("display_backlight")}
                onClick={() => {
                  setBacklight(p);
                  void run("display_backlight", { percent: p });
                }}
              >
                {p}%
              </Button>
            ))}
          </div>
        </Panel>

        <Panel title="calls" className="min-w-0">
          {log.length === 0 ? (
            <p className="text-xs text-muted">Nothing run yet. Every call here is logged in the device session too.</p>
          ) : (
            <ul className="space-y-1.5 text-xs">
              <AnimatePresence initial={false}>
                {log.map((c) => (
                  <motion.li key={c.at} layout="position" initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} className="flex min-w-0 gap-2">
                    <Tag tone={c.ok ? "phos" : "err"}>{c.ok ? "ok" : "fail"}</Tag>
                    <span className="min-w-0 flex-1 overflow-hidden">
                      <span className="text-fg">{c.name}</span>
                      <span className="block truncate text-[11px] text-amber-faint" title={c.detail}>
                        {c.detail}
                      </span>
                    </span>
                  </motion.li>
                ))}
              </AnimatePresence>
            </ul>
          )}
        </Panel>
      </div>
    </div>
  );
}
