"use client";

import { motion } from "motion/react";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { ActivityChart } from "@/components/charts/activity-chart";
import { DeviceKindIcon } from "@/components/term/device-kind";
import { AsciiBar, AsciiSpark, CountUp, TimeAgo } from "@/components/term/motion";
import { ButtonLink, EmptyState, Led, Panel, Tag } from "@/components/term/primitives";
import { LiveFeed } from "@/components/term/live-feed";
import { useLive } from "@/hooks/use-live";
import { cn } from "@/lib/cn";
import { fleetState, type PeerInfo } from "@/lib/fleet-view";
import { compact } from "@/lib/format";
import type { DashboardStats } from "@/lib/db/stats";
import type { Device, EventRow } from "@/lib/types";

export function Dashboard({ stats, events, devices: initialDevices, peers = {} }: { stats: DashboardStats; events: EventRow[]; devices: Device[]; peers?: Record<string, PeerInfo> }) {
  const [devices, setDevices] = useState(initialDevices);
  const [errors, setErrors] = useState(stats.errors24h);
  const [chats, setChats] = useState(0);

  useLive((msg) => {
    if (msg.kind === "presence") {
      setDevices((ds) => ds.map((d) => (d.id === msg.deviceId ? { ...d, status: msg.status, ip: msg.ip ?? d.ip, last_seen_at: msg.at } : d)));
    } else if (msg.kind === "event") {
      if (msg.event.level === "error") setErrors((n) => n + 1);
      if (msg.event.type === "chat") setChats((n) => n + 1);
      setDevices((ds) => ds.map((d) => (d.id === msg.event.device_id ? { ...d, last_seen_at: msg.event.created_at } : d)));
    }
  });

  const up = devices.filter((d) => fleetState(d, peers[d.id]).live).length;
  const hourlyErrors = stats.hourly.map((h) => h.errors);

  return (
    <div className="grid gap-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <Stat i={0} label="nodes up" tone="phos" value={up} suffix={<span className="text-amber-faint">/{devices.length}</span>}>
          <AsciiBar value={devices.length ? up / devices.length : 0} width={14} tone="phos" />
        </Stat>
        <Stat i={1} label="sessions today" value={stats.sessionsToday}>
          <AsciiSpark data={stats.daily.map((d) => d.sessions)} className="text-amber-dim" />
        </Stat>
        <Stat i={2} label="messages 24h" value={stats.messages24h + chats * 2}>
          <span className="text-[11px] text-muted">{chats ? <span className="text-phos">+{chats * 2} live</span> : "user + assistant"}</span>
        </Stat>
        <Stat i={3} label="tokens today" value={stats.tokensToday}>
          <AsciiSpark data={stats.daily.map((d) => d.tokens)} className="text-amber-dim" />
        </Stat>
        <Stat i={4} label="errors 24h" tone={errors ? "err" : "amber"} value={errors}>
          <AsciiSpark data={hourlyErrors.length ? hourlyErrors : [0]} className={errors ? "text-err/70" : "text-amber-faint"} />
        </Stat>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <Panel title="activity // 24h" className="xl:col-span-2" actions={<Legend />}>
          <ActivityChart hourly={stats.hourly} />
        </Panel>
        <Panel title="model usage // 7d">
          {stats.models.length ? (
            <ModelUsage models={stats.models} />
          ) : (
            <EmptyState title="no inference yet">Chats from devices or the console show up here.</EmptyState>
          )}
        </Panel>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <Panel
          title="live traffic"
          className="xl:col-span-2"
          bodyClassName="p-0"
          actions={
            <Link href="/logs" className="text-[11px] text-muted hover:text-amber">
              all logs →
            </Link>
          }
        >
          <LiveFeed initial={events} height="h-[380px]" />
        </Panel>
        <Panel title="nodes" actions={
            <ButtonLink href="/settings/devices" size="sm">
              add
            </ButtonLink>
          }>
          <DeviceGrid devices={devices} peers={peers} />
        </Panel>
      </div>
    </div>
  );
}

function Stat({ label, value, suffix, children, tone = "amber", i }: { label: string; value: number; suffix?: ReactNode; children?: ReactNode; tone?: "amber" | "phos" | "err"; i: number }) {
  const color = { amber: "text-amber glow", phos: "text-phos glow-phos", err: "text-err glow-err" }[tone];
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.05 * i, duration: 0.3 }}
      whileHover={{ y: -2 }}
      className="group relative overflow-hidden border border-line bg-panel/80 p-3 transition-colors hover:border-line-2"
    >
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-amber/60 to-transparent opacity-0 transition-opacity group-hover:opacity-100" />
      <p className="text-[10px] uppercase tracking-[0.2em] text-muted">
        <span className="text-amber-dim">▸ </span>
        {label}
      </p>
      <p className={cn("mt-1 font-display text-5xl leading-none", color)}>
        <CountUp value={value} />
        {suffix && <span className="text-3xl">{suffix}</span>}
      </p>
      <div className="mt-2 h-4 overflow-hidden text-xs leading-4">{children}</div>
    </motion.div>
  );
}

function Legend() {
  return (
    <span className="hidden gap-3 text-[10px] uppercase tracking-[0.14em] sm:flex">
      <span className="text-amber">■ events</span>
      <span className="text-phos">■ chats</span>
      <span className="text-err">■ errors</span>
    </span>
  );
}

function ModelUsage({ models }: { models: DashboardStats["models"] }) {
  const max = Math.max(1, ...models.map((m) => m.tokens));
  return (
    <ul className="space-y-3">
      {models.map((m, i) => (
        <li key={m.model}>
          <div className="flex items-baseline justify-between gap-2 text-xs">
            <span className="truncate text-fg">
              <span className="text-amber-dim">{String(i + 1).padStart(2, "0")} </span>
              {m.model}
            </span>
            <span className="shrink-0 tabular-nums text-muted">
              {compact(m.tokens)} tok · {m.sessions} ses
            </span>
          </div>
          <AsciiBar value={m.tokens / max} width={28} className="text-xs" tone={i === 0 ? "amber" : "phos"} />
        </li>
      ))}
    </ul>
  );
}

function DeviceGrid({ devices, peers }: { devices: Device[]; peers: Record<string, PeerInfo> }) {
  if (!devices.length) {
    return <EmptyState title="no nodes registered">Add a device in settings to get its token.</EmptyState>;
  }
  const state = (d: Device) => fleetState(d, peers[d.id]);
  const sorted = [...devices].sort((a, b) => Number(state(b).live) - Number(state(a).live));
  return (
    <ul className="grid gap-2">
      {sorted.map((d, i) => (
        <motion.li key={d.id} layout initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.04 }}>
          <Link
            href={`/devices/${d.id}`}
            className={cn(
              "group flex items-center gap-3 border px-3 py-2 transition-all hover:translate-x-0.5",
              state(d).live ? "border-phos/30 bg-phos/[0.03] hover:border-phos/70" : "border-line hover:border-line-2",
            )}
          >
            <Led on={state(d).live} tone={state(d).tone} label={state(d).label} />
            <DeviceKindIcon kind={d.kind} className={state(d).live ? "text-phos" : "text-amber-dim"} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs text-fg group-hover:text-amber">{d.name}</p>
              <p className="truncate text-[10px] text-muted">
                {d.kind === "agent" ? (peers[d.id]?.host ?? "no endpoint") : (d.ip ?? "no ip")} · <TimeAgo iso={d.last_seen_at} />
              </p>
            </div>
            <Tag tone={state(d).live ? "phos" : state(d).tone === "err" ? "err" : "muted"}>{state(d).label}</Tag>
          </Link>
        </motion.li>
      ))}
    </ul>
  );
}
