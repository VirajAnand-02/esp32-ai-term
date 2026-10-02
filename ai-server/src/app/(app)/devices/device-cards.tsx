"use client";

import { motion } from "motion/react";
import Link from "next/link";
import { useState } from "react";
import { DeviceKindIcon } from "@/components/term/device-kind";
import { TimeAgo } from "@/components/term/motion";
import { EmptyState, Led, Tag } from "@/components/term/primitives";
import { useLive } from "@/hooks/use-live";
import { cn } from "@/lib/cn";
import { fleetBucket, fleetState, type PeerInfo } from "@/lib/fleet-view";
import type { Device } from "@/lib/types";

export function DeviceCards({ initial, peers = {} }: { initial: Device[]; peers?: Record<string, PeerInfo> }) {
  const [devices, setDevices] = useState(initial);
  const [pulse, setPulse] = useState<Record<string, number>>({});
  const [filter, setFilter] = useState<"all" | "up" | "down">("all");

  useLive((msg) => {
    if (msg.kind === "presence") {
      setDevices((ds) => ds.map((d) => (d.id === msg.deviceId ? { ...d, status: msg.status, ip: msg.ip ?? d.ip, last_seen_at: msg.at } : d)));
    } else if (msg.kind === "event" && msg.event.device_id) {
      const id = msg.event.device_id;
      setPulse((p) => ({ ...p, [id]: (p[id] ?? 0) + 1 }));
      setDevices((ds) => ds.map((d) => (d.id === id ? { ...d, last_seen_at: msg.event.created_at } : d)));
    }
  });

  // "up" and "down" rather than online/offline, because the column now holds both
  // presence and reachability. An unchecked agent is in neither, which is honest.
  const bucket = (d: Device) => fleetBucket(d, peers[d.id]);
  const shown = devices.filter((d) => filter === "all" || bucket(d) === filter);

  if (!devices.length) {
    return (
      <EmptyState title="no devices yet">
        Add one under <Link href="/settings/devices" className="text-amber underline">settings / devices</Link> to get its connection token.
      </EmptyState>
    );
  }

  return (
    <>
      <div className="mb-4 flex gap-1 text-[11px] uppercase tracking-[0.14em]">
        {(["all", "up", "down"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={cn(
              "cursor-pointer border px-2 py-1 transition-colors",
              filter === f ? "border-amber bg-amber/10 text-amber" : "border-line text-muted hover:text-fg",
            )}
          >
            {f} <span className="text-amber-faint">{f === "all" ? devices.length : devices.filter((d) => bucket(d) === f).length}</span>
          </button>
        ))}
      </div>
      <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {shown.map((d, i) => {
          const peer = peers[d.id];
          const isAgent = d.kind === "agent";
          const state = fleetState(d, peer);
          const on = state.live;
          return (
            <motion.li
              key={d.id}
              layout
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.04 }}
            >
              <Link
                href={`/devices/${d.id}`}
                className={cn(
                  "group relative block overflow-hidden border bg-panel/80 p-4 transition-all duration-200 hover:-translate-y-0.5",
                  on ? "border-phos/30 hover:border-phos/70 hover:shadow-[0_0_24px_rgb(57_255_122/0.08)]" : "border-line hover:border-amber/50",
                )}
              >
                {/* activity flash whenever this device sends something */}
                <motion.span
                  key={pulse[d.id] ?? 0}
                  initial={{ opacity: pulse[d.id] ? 0.5 : 0 }}
                  animate={{ opacity: 0 }}
                  transition={{ duration: 1.2 }}
                  className="pointer-events-none absolute inset-0 bg-amber/20"
                />
                <div className="flex items-start gap-3">
                  <div className={cn("grid size-10 place-items-center border", on ? "border-phos/40 text-phos" : "border-line text-amber-dim")}>
                    <DeviceKindIcon kind={d.kind} className="size-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 text-sm text-fg group-hover:text-amber">
                      <span className="truncate">{d.name}</span>
                    </p>
                    <p className="truncate text-[11px] text-muted">
                      {isAgent ? (peer?.host ?? "no endpoint set") : d.hostname ? `${d.hostname}.local` : d.kind}
                    </p>
                  </div>
                  <span className="flex items-center gap-1.5 text-[10px] uppercase">
                    <Led on={on} tone={state.tone} label={state.label} />
                    <span className={cn(on ? "text-phos" : state.tone === "err" ? "text-err" : "text-muted")}>{state.label}</span>
                  </span>
                </div>
                <dl className="mt-4 grid grid-cols-3 gap-2 border-t border-dashed border-line pt-3 text-[11px]">
                  {isAgent ? (
                    <>
                      <Field label="via" value="http" />
                      <Field label="model" value={peer?.model ?? "harness picks"} />
                      <div>
                        <dt className="text-amber-faint">asked</dt>
                        <dd className="truncate text-fg/80">
                          <TimeAgo iso={d.last_seen_at} />
                        </dd>
                      </div>
                    </>
                  ) : (
                    <>
                      <Field label="ip" value={d.ip ?? "—"} />
                      <Field label="fw" value={d.firmware ?? "—"} />
                      <div>
                        <dt className="text-amber-faint">seen</dt>
                        <dd className="truncate text-fg/80">
                          <TimeAgo iso={d.last_seen_at} />
                        </dd>
                      </div>
                    </>
                  )}
                </dl>
                <div className="mt-3 flex items-center justify-between">
                  <Tag tone={isAgent ? "info" : "muted"}>{d.kind}</Tag>
                  <span className="text-[11px] text-amber-dim transition-transform group-hover:translate-x-1">open →</span>
                </div>
              </Link>
            </motion.li>
          );
        })}
      </ul>
    </>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-amber-faint">{label}</dt>
      <dd className="truncate text-fg/80" title={value}>
        {value}
      </dd>
    </div>
  );
}
