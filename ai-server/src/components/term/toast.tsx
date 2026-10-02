"use client";

import { AnimatePresence, motion } from "motion/react";
import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Typewriter } from "./motion";

type Tone = "ok" | "err" | "info";
type Toast = { id: number; tone: Tone; text: string };

const ToastCtx = createContext<(text: string, tone?: Tone) => void>(() => {});

export function useToast() {
  return useContext(ToastCtx);
}

let seq = 0;

// Toasts render as lines printed to a little terminal in the corner.
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const push = useCallback((text: string, tone: Tone = "ok") => {
    const id = ++seq;
    setToasts((t) => [...t.slice(-3), { id, tone, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200);
  }, []);

  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed bottom-4 right-4 z-[90] flex w-[min(92vw,380px)] flex-col gap-1.5">
        <AnimatePresence initial={false}>
          {toasts.map((t) => (
            <motion.div
              key={t.id}
              layout
              initial={{ opacity: 0, x: 24, scaleY: 0.2 }}
              animate={{ opacity: 1, x: 0, scaleY: 1 }}
              exit={{ opacity: 0, scaleY: 0.1, filter: "brightness(3)" }}
              transition={{ duration: 0.18 }}
              className={cn(
                "border bg-panel/95 px-3 py-2 text-xs shadow-[0_8px_30px_rgb(0_0_0/0.6)] backdrop-blur",
                t.tone === "ok" && "border-phos/50 text-phos",
                t.tone === "err" && "border-err/60 text-err",
                t.tone === "info" && "border-amber/50 text-amber",
              )}
            >
              <span className="text-amber-dim">[{t.tone === "ok" ? " ok " : t.tone === "err" ? "fail" : "info"}] </span>
              <Typewriter text={t.text} speed={10} />
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastCtx.Provider>
  );
}
