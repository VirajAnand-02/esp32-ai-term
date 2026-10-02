"use client";

import { motion } from "motion/react";
import Link from "next/link";
import { useId, type ReactNode } from "react";
import { cn } from "@/lib/cn";

type Tab = { id: string; label: ReactNode; href?: string };

export function Tabs({ tabs, active, onChange, className }: { tabs: Tab[]; active: string; onChange?: (id: string) => void; className?: string }) {
  const layoutId = useId();
  return (
    <div role="tablist" className={cn("flex gap-1 overflow-x-auto border-b border-line", className)}>
      {tabs.map((t) => {
        const isActive = t.id === active;
        const cls = cn(
          "relative shrink-0 px-3 py-2 text-[11px] uppercase tracking-[0.16em] transition-colors",
          isActive ? "text-amber glow" : "text-muted hover:text-fg",
        );
        const inner = (
          <>
            <span className={cn("transition-opacity", isActive ? "opacity-100" : "opacity-0")}>&gt; </span>
            {t.label}
            {isActive && (
              <motion.span
                layoutId={layoutId}
                className="absolute inset-x-0 -bottom-px h-px bg-amber shadow-[0_0_8px_var(--amber)]"
                transition={{ type: "spring", stiffness: 500, damping: 38 }}
              />
            )}
          </>
        );
        return t.href ? (
          <Link key={t.id} href={t.href} role="tab" aria-selected={isActive} className={cls}>
            {inner}
          </Link>
        ) : (
          <button key={t.id} role="tab" aria-selected={isActive} className={cn(cls, "cursor-pointer")} onClick={() => onChange?.(t.id)}>
            {inner}
          </button>
        );
      })}
    </div>
  );
}
