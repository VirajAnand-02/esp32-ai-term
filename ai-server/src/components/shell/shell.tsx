"use client";

import { AnimatePresence, motion } from "motion/react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { logout } from "@/app/actions/auth";
import { useNow } from "@/components/term/motion";
import { Kbd, Led } from "@/components/term/primitives";
import { ToastProvider } from "@/components/term/toast";
import { useLive, useLiveStatus } from "@/hooks/use-live";
import { cn } from "@/lib/cn";
import { CommandPalette, type PaletteDevice } from "./command-palette";
import { isActive, NAV } from "./nav";

const LOGO = String.raw`
 ▄▀█ █   ▀█▀ █▀▀ █▀█ █▀▄▀█
 █▀█ █ ▄  █  ██▄ █▀▄ █ ▀ █`;

export function Shell({ user, devices: initial, children }: { user: string; devices: PaletteDevice[]; children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  // Live presence layered over the server list, so router.refresh() still brings in new devices.
  const [presence, setPresence] = useState<Record<string, boolean>>({});
  const devices = initial.map((d) => ({ ...d, online: presence[d.id] ?? d.online }));
  const [palette, setPalette] = useState(false);
  const [drawer, setDrawer] = useState(false);

  useLive((msg) => {
    if (msg.kind === "presence") {
      setPresence((p) => ({ ...p, [msg.deviceId]: msg.status === "online" }));
    }
  });

  // Ctrl/⌘+K opens the palette; "g" then a key jumps to a page.
  useEffect(() => {
    let pendingG = 0;
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      const typing = target.closest("input, textarea, select, [contenteditable]");
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((p) => !p);
        return;
      }
      if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "g") {
        pendingG = Date.now();
        return;
      }
      if (Date.now() - pendingG < 900) {
        const hit = NAV.find((n) => n.key === e.key);
        if (hit) router.push(hit.href);
        pendingG = 0;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router]);

  // Every row counts as a node, attached agents included. `online` already means "up"
  // rather than "connected" -- the layout derives it through fleetState, so a reachable
  // harness is up and a dead one is down, the same as a device that dropped its socket.
  const online = devices.filter((d) => d.online).length;

  const sidebar = (
    <nav className="flex h-full flex-col gap-6 p-4">
      <Link href="/" className="group block" onClick={() => setDrawer(false)}>
        <pre className="font-mono text-[9px] leading-[1.1] text-amber glow transition-[filter] group-hover:brightness-125">{LOGO}</pre>
        <p className="mt-1 text-[10px] uppercase tracking-[0.3em] text-amber-dim">control // v0.1</p>
      </Link>

      <ul className="flex flex-col gap-0.5">
        {NAV.map((n) => {
          const active = isActive(pathname, n.href);
          const Icon = n.icon;
          return (
            <li key={n.href}>
              <Link
                href={n.href}
                onClick={() => setDrawer(false)}
                className={cn(
                  "group/nav relative flex items-center gap-2 px-2 py-1.5 text-xs uppercase tracking-[0.16em] transition-colors",
                  active ? "text-amber glow" : "text-muted hover:text-fg",
                )}
              >
                {active && (
                  <motion.span
                    layoutId="nav-active"
                    className="absolute inset-0 border-l-2 border-amber bg-amber/[0.07]"
                    transition={{ type: "spring", stiffness: 500, damping: 40 }}
                  />
                )}
                <span className={cn("relative w-3 transition-all", active ? "opacity-100" : "-translate-x-1 opacity-0 group-hover/nav:translate-x-0 group-hover/nav:opacity-100")}>&gt;</span>
                <Icon size={14} strokeWidth={1.5} className="relative" />
                <span className="relative flex-1">{n.label}</span>
                <span className="relative text-[10px] normal-case text-amber-faint opacity-0 transition-opacity group-hover/nav:opacity-100">g {n.key}</span>
              </Link>
            </li>
          );
        })}
      </ul>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <p className="mb-2 text-[10px] uppercase tracking-[0.2em] text-amber-dim">
          nodes <span className="text-phos">{online}</span>/{devices.length}
        </p>
        <ul className="flex flex-col gap-0.5">
          {devices.map((d) => (
            <li key={d.id}>
              <Link
                href={`/devices/${d.id}`}
                onClick={() => setDrawer(false)}
                className={cn(
                  "flex items-center gap-2 px-2 py-1 text-[11px] transition-colors hover:bg-amber/5",
                  pathname === `/devices/${d.id}` ? "text-amber" : d.online ? "text-fg" : "text-muted",
                )}
              >
                <Led on={d.online} tone={d.tone} label={d.label} />
                <span className="truncate">{d.name}</span>
              </Link>
            </li>
          ))}
        </ul>
      </div>

      <button
        onClick={() => setPalette(true)}
        className="flex cursor-pointer items-center justify-between border border-dashed border-line px-2 py-1.5 text-[11px] text-muted transition-colors hover:border-amber hover:text-amber"
      >
        <span>&gt; command…</span>
        <Kbd>ctrl k</Kbd>
      </button>
    </nav>
  );

  return (
    <ToastProvider>
      <div className="grid min-h-dvh lg:grid-cols-[232px_minmax(0,1fr)]">
        <aside className="sticky top-0 hidden h-dvh border-r border-line bg-bg-2/80 lg:block">{sidebar}</aside>

        <AnimatePresence>
          {drawer && (
            <motion.div className="fixed inset-0 z-[70] lg:hidden" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <div className="absolute inset-0 bg-bg/80" onClick={() => setDrawer(false)} />
              <motion.aside
                className="absolute inset-y-0 left-0 w-64 border-r border-amber/40 bg-bg-2"
                initial={{ x: -260 }}
                animate={{ x: 0 }}
                exit={{ x: -260 }}
                transition={{ type: "spring", stiffness: 420, damping: 40 }}
              >
                {sidebar}
              </motion.aside>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="flex min-w-0 flex-col">
          <TopBar user={user} online={online} total={devices.length} onMenu={() => setDrawer(true)} onPalette={() => setPalette(true)} />
          <main className="mx-auto w-full max-w-[1400px] flex-1 px-4 py-6 sm:px-6">{children}</main>
        </div>
      </div>
      <CommandPalette open={palette} onClose={() => setPalette(false)} devices={devices} />
    </ToastProvider>
  );
}

// The CRT preference lives on <html data-fx>, set before paint by the root layout.
function subscribeFx(cb: () => void) {
  const mo = new MutationObserver(cb);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-fx"] });
  return () => mo.disconnect();
}

function TopBar({ user, online, total, onMenu, onPalette }: { user: string; online: number; total: number; onMenu: () => void; onPalette: () => void }) {
  const pathname = usePathname();
  const link = useLiveStatus();
  const now = useNow();
  const fx = useSyncExternalStore(subscribeFx, () => document.documentElement.dataset.fx !== "off", () => true);

  function toggleFx() {
    const next = !fx;
    document.documentElement.dataset.fx = next ? "on" : "off";
    try {
      localStorage.setItem("aiterm.fx", next ? "on" : "off");
    } catch {}
  }

  return (
    <header className="sticky top-0 z-40 flex h-11 items-center gap-3 border-b border-line bg-bg/85 px-4 text-[11px] backdrop-blur sm:px-6">
      <button onClick={onMenu} className="cursor-pointer text-amber lg:hidden" aria-label="Open menu">
        [≡]
      </button>
      <span className="truncate text-muted">
        <span className="text-phos">{user}@ai-term</span>:<span className="text-info">~{pathname === "/" ? "" : pathname}</span>$
      </span>
      <div className="ml-auto flex items-center gap-4">
        <button onClick={onPalette} className="hidden cursor-pointer text-muted hover:text-amber sm:inline lg:hidden">
          [⌘k]
        </button>
        <span className="hidden items-center gap-1.5 sm:flex" title={link ? "live stream connected" : "live stream reconnecting"}>
          <Led on={link} tone={link ? "phos" : "err"} />
          <span className={link ? "text-phos" : "text-err"}>{link ? "LINK" : "NO LINK"}</span>
        </span>
        <span className="flex items-center gap-1.5">
          <span className="text-amber-dim">nodes</span>
          <span className="text-phos glow-phos">{online}</span>
          <span className="text-amber-faint">/{total}</span>
        </span>
        <span className="hidden tabular-nums text-amber md:inline">{now ? new Date(now).toLocaleTimeString([], { hour12: false }) : "--:--:--"}</span>
        <button onClick={toggleFx} className="cursor-pointer text-muted transition-colors hover:text-amber" title="Toggle CRT effects">
          fx:{fx ? <span className="text-amber">on</span> : "off"}
        </button>
        <form action={logout}>
          <button className="cursor-pointer text-muted transition-colors hover:text-err">logout</button>
        </form>
      </div>
    </header>
  );
}
