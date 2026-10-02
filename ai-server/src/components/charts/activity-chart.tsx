"use client";

import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { DashboardStats } from "@/lib/db/stats";

type Point = { label: string; events: number; chats: number; errors: number };

// Fills in empty hours so the chart always spans the last 24.
// Buckets are UTC hours (date_trunc in Postgres), which only line up with local
// hours in whole-hour timezones, so align on UTC and label in local time.
function toSeries(hourly: DashboardStats["hourly"]): Point[] {
  const HOUR = 3_600_000;
  const byHour = new Map(hourly.map((h) => [Math.floor(new Date(h.hour).getTime() / HOUR), h]));
  const current = Math.floor(Date.now() / HOUR);
  const out: Point[] = [];
  for (let i = 23; i >= 0; i--) {
    const slot = current - i;
    const h = byHour.get(slot);
    const d = new Date(slot * HOUR);
    out.push({
      label: `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`,
      events: h?.events ?? 0,
      chats: h?.chats ?? 0,
      errors: h?.errors ?? 0,
    });
  }
  return out;
}

export function ActivityChart({ hourly }: { hourly: DashboardStats["hourly"] }) {
  const data = toSeries(hourly);
  return (
    <div className="h-[260px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
          <defs>
            <linearGradient id="g-amber" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#ffb000" stopOpacity={0.45} />
              <stop offset="100%" stopColor="#ffb000" stopOpacity={0} />
            </linearGradient>
            <linearGradient id="g-phos" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#39ff7a" stopOpacity={0.35} />
              <stop offset="100%" stopColor="#39ff7a" stopOpacity={0} />
            </linearGradient>
            <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
              <feGaussianBlur stdDeviation="2.2" result="b" />
              <feMerge>
                <feMergeNode in="b" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>
          <CartesianGrid stroke="#3a2c14" strokeDasharray="2 4" vertical={false} />
          <XAxis dataKey="label" tick={{ fill: "#9a7a44", fontSize: 10 }} tickLine={false} axisLine={{ stroke: "#3a2c14" }} interval={3} />
          <YAxis tick={{ fill: "#9a7a44", fontSize: 10 }} tickLine={false} axisLine={false} allowDecimals={false} />
          <Tooltip content={<TermTooltip />} cursor={{ stroke: "#ffb000", strokeDasharray: "3 3" }} />
          <Area type="stepAfter" dataKey="events" stroke="#ffb000" strokeWidth={1.5} fill="url(#g-amber)" filter="url(#glow)" animationDuration={900} />
          <Area type="stepAfter" dataKey="chats" stroke="#39ff7a" strokeWidth={1.5} fill="url(#g-phos)" filter="url(#glow)" animationDuration={1100} />
          <Area type="stepAfter" dataKey="errors" stroke="#ff4d3d" strokeWidth={1.5} fill="transparent" animationDuration={1300} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

function TermTooltip({ active, payload, label }: { active?: boolean; payload?: { dataKey?: unknown; value?: unknown }[]; label?: unknown }) {
  if (!active || !payload?.length) return null;
  const color: Record<string, string> = { events: "text-amber", chats: "text-phos", errors: "text-err" };
  return (
    <div className="border border-amber/60 bg-panel/95 px-2.5 py-1.5 text-[11px] shadow-[0_0_20px_rgb(255_176_0/0.2)]">
      <p className="mb-0.5 text-amber-dim">&gt; {String(label)}</p>
      {payload.map((p) => (
        <p key={String(p.dataKey)} className={color[String(p.dataKey)]}>
          {String(p.dataKey).padEnd(7, ".")} {String(p.value)}
        </p>
      ))}
    </div>
  );
}
