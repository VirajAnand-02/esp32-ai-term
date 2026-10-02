"use client";

import { AnimatePresence, motion } from "motion/react";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Led } from "@/components/term/primitives";
import { cn } from "@/lib/cn";
import { NAV } from "./nav";

// `agent` marks an attached harness: it never connects, so `online` is meaningless
// for one and showing it as offline reads as a fault.
export type PaletteDevice = {
  id: string;
  name: string;
  /** Worth lighting up: connected, or an agent that answers. */
  online: boolean;
  agent?: boolean;
  label?: string;
  tone?: "phos" | "amber" | "err";
};

type Item = { id: string; label: string; hint: string; href: string; online?: boolean };

export function CommandPalette({ open, onClose, devices }: { open: boolean; onClose: () => void; devices: PaletteDevice[] }) {
  return <AnimatePresence>{open && <Palette onClose={onClose} devices={devices} />}</AnimatePresence>;
}

// Mounted fresh on every open, so the query always starts empty.
function Palette({ onClose, devices }: { onClose: () => void; devices: PaletteDevice[] }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);

  const items = useMemo<Item[]>(() => {
    const all: Item[] = [
      ...NAV.map((n) => ({ id: n.href, label: `goto ${n.label}`, hint: `g ${n.key}`, href: n.href })),
      { id: "llm", label: "settings / llm", hint: "model, prompt", href: "/settings/llm" },
      { id: "add", label: "settings / devices / add", hint: "new token", href: "/settings/devices" },
      { id: "mem", label: "settings / memories", hint: "", href: "/settings/memories" },
      { id: "dbs", label: "settings / databases", hint: "", href: "/settings/databases" },
      ...devices.map((d) => ({ id: d.id, label: `${d.agent ? "agent" : "device"} ${d.name}`, hint: d.agent ? "over http" : d.online ? "online" : "offline", href: `/devices/${d.id}`, online: d.agent ? undefined : d.online })),
    ];
    const needle = q.trim().toLowerCase();
    if (!needle) return all;
    // Subsequence match: "dvk" finds "device kitchen".
    return all.filter((i) => {
      let j = 0;
      for (const ch of i.label.toLowerCase()) if (ch === needle[j]) j++;
      return j === needle.length;
    });
  }, [q, devices]);

  function go(item: Item | undefined) {
    if (!item) return;
    onClose();
    router.push(item.href);
  }

  return (
    <motion.div
      className="fixed inset-0 z-[80] flex items-start justify-center bg-bg/70 px-4 pt-[14vh] backdrop-blur-sm"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onMouseDown={onClose}
    >
      <motion.div
        role="dialog"
        aria-label="Command palette"
        className="w-full max-w-lg border border-amber/60 bg-panel shadow-[0_0_40px_rgb(255_176_0/0.15)]"
        initial={{ scaleY: 0.05, opacity: 0 }}
        animate={{ scaleY: 1, opacity: 1 }}
        exit={{ scaleY: 0.05, opacity: 0 }}
        transition={{ duration: 0.16, ease: "easeOut" }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-line px-3">
          <span className="text-amber glow">&gt;</span>
          <input
            autoFocus
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setSel(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSel((s) => Math.min(items.length - 1, s + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setSel((s) => Math.max(0, s - 1));
              } else if (e.key === "Enter") {
                go(items[sel]);
              } else if (e.key === "Escape") {
                onClose();
              }
            }}
            placeholder="type a command or device…"
            className="h-11 w-full bg-transparent text-sm text-fg outline-none placeholder:text-amber-faint"
          />
          <kbd className="text-[10px] text-amber-faint">esc</kbd>
        </div>
        <ul className="max-h-80 overflow-y-auto py-1">
          {items.length === 0 && <li className="px-3 py-3 text-xs text-muted">command not found: {q}</li>}
          {items.map((item, i) => (
            <li key={item.id}>
              <button
                className={cn(
                  "flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors",
                  i === sel ? "bg-amber text-bg" : "text-fg hover:bg-amber/10",
                )}
                onMouseEnter={() => setSel(i)}
                onClick={() => go(item)}
              >
                <span className="w-3">{i === sel ? "▸" : ""}</span>
                {item.online !== undefined && <Led on={item.online} />}
                <span className="flex-1 truncate">{item.label}</span>
                <span className={cn("text-[10px]", i === sel ? "text-bg/70" : "text-amber-faint")}>{item.hint}</span>
              </button>
            </li>
          ))}
        </ul>
      </motion.div>
    </motion.div>
  );
}
