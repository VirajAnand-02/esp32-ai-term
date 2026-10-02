"use client";

import { motion } from "motion/react";

// Re-mounts on every navigation: content fades up while a phosphor bar wipes away.
export default function Template({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative">
      <motion.div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 z-10 h-px bg-amber shadow-[0_0_16px_4px_rgb(255_176_0/0.5)]"
        initial={{ y: 0, opacity: 1 }}
        animate={{ y: 260, opacity: 0 }}
        transition={{ duration: 0.45, ease: "easeIn" }}
      />
      <motion.div initial={{ opacity: 0, y: 6, filter: "blur(2px)" }} animate={{ opacity: 1, y: 0, filter: "blur(0px)" }} transition={{ duration: 0.28 }}>
        {children}
      </motion.div>
    </div>
  );
}
