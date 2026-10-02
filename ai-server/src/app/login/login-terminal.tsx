"use client";

import { AnimatePresence, motion } from "motion/react";
import { useActionState, useEffect, useRef, useState } from "react";
import { login, type LoginState } from "@/app/actions/auth";
import { cn } from "@/lib/cn";

const BOOT = [
  { t: "AI-TERM CONTROL BIOS v0.1", tone: "text-amber glow" },
  { t: "(c) esp32-ai-term project", tone: "text-amber-dim" },
  { t: "" },
  { t: "memory test ........ 8192K OK", tone: "text-fg" },
  { t: "ws gateway ......... /ws [armed]", tone: "text-fg" },
  { t: "llm registry ....... deepseek anthropic openai google", tone: "text-fg" },
  { t: "supabase link ...... secret key [server only]", tone: "text-fg" },
  { t: "" },
  { t: "authentication required.", tone: "text-phos glow-phos" },
];

const BANNER = String.raw`
    ___    ____      ______________  __  ___
   /   |  /  _/     /_  __/ ____/ _ \/  |/  /
  / /| |  / /  ______/ / / __/ / , _/ /|_/ /
 / ___ |_/ /  /_____/ / / /___/ /| / /  / /
/_/  |_/___/       /_/ /_____/_/ |_/_/  /_/
`;

export function LoginTerminal({ next }: { next: string }) {
  const [state, action, pending] = useActionState<LoginState, FormData>(login, {});
  const [lines, setLines] = useState(0);
  const booted = lines >= BOOT.length;
  const userRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let i = 0;
    const id = setInterval(() => {
      i = reduced ? BOOT.length : i + 1;
      setLines(i);
      if (i >= BOOT.length) clearInterval(id);
    }, reduced ? 0 : 140);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (booted) userRef.current?.focus();
  }, [booted]);

  return (
    <motion.div
      initial={{ scaleY: 0.004, scaleX: 0.6, opacity: 0.2, filter: "brightness(4)" }}
      animate={{ scaleY: 1, scaleX: 1, opacity: 1, filter: "brightness(1)" }}
      transition={{ duration: 0.55, ease: [0.2, 0.9, 0.2, 1] }}
      className="relative w-full max-w-xl border border-amber/50 bg-panel/90 shadow-[0_0_60px_rgb(255_176_0/0.12),inset_0_0_80px_rgb(0_0_0/0.6)]"
    >
      <div className="flex items-center justify-between border-b border-line px-3 py-1.5 text-[10px] uppercase tracking-[0.2em] text-amber-dim">
        <span>tty0 // ai-term</span>
        <span className="flex gap-1.5">
          <span className="size-2 rounded-full bg-err/70" />
          <span className="size-2 rounded-full bg-amber/70" />
          <span className="size-2 rounded-full bg-phos/70" />
        </span>
      </div>

      <div className="p-5 sm:p-7">
        <pre className="mb-4 overflow-hidden font-mono text-[8px] leading-[1.15] text-amber glow sm:text-[10px]">{BANNER}</pre>

        <div className="min-h-[190px] text-xs leading-relaxed">
          {BOOT.slice(0, lines).map((l, i) => (
            <motion.p key={i} initial={{ opacity: 0 }} animate={{ opacity: 1 }} className={cn("whitespace-pre", l.tone)}>
              {l.t || " "}
            </motion.p>
          ))}
          {!booted && <span className="cursor" />}
        </div>

        <AnimatePresence>
          {booted && (
            <motion.form
              key={state.attempt ?? 0}
              action={action}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              className={cn("mt-2 space-y-2 text-sm", state.error && "shake")}
            >
              <input type="hidden" name="next" value={next} />
              <label className="flex items-center gap-2">
                <span className="w-24 shrink-0 text-amber-dim">login:</span>
                <input
                  ref={userRef}
                  name="username"
                  autoComplete="username"
                  required
                  defaultValue="admin"
                  className="w-full border-b border-dashed border-line bg-transparent py-1 text-amber outline-none transition-colors focus:border-amber"
                />
              </label>
              <label className="flex items-center gap-2">
                <span className="w-24 shrink-0 text-amber-dim">password:</span>
                <input
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  autoFocus
                  className="w-full border-b border-dashed border-line bg-transparent py-1 tracking-[0.3em] text-amber outline-none transition-colors focus:border-amber"
                />
              </label>

              <div className="flex items-center justify-between pt-4">
                <p className={cn("text-xs", state.error ? "text-err glow-err" : "text-amber-faint")}>
                  {pending ? (
                    <span className="text-amber">verifying<span className="animate-blink">…</span></span>
                  ) : state.error ? (
                    <>!! {state.error}</>
                  ) : (
                    "press enter to authenticate"
                  )}
                </p>
                <button
                  disabled={pending}
                  className="press cursor-pointer border border-amber px-4 py-1.5 text-xs uppercase tracking-[0.2em] text-amber transition-all hover:bg-amber hover:text-bg hover:shadow-[0_0_20px_rgb(255_176_0/0.5)] disabled:opacity-50"
                >
                  [ enter ]
                </button>
              </div>
            </motion.form>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}
