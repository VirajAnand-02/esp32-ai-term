"use client";

import { AnimatePresence, motion } from "motion/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { disconnectDevice, saveDeviceConfig } from "@/app/actions/devices";
import { DeviceKindIcon } from "@/components/term/device-kind";
import { LiveFeed } from "@/components/term/live-feed";
import { AudioPanel } from "./audio-panel";
import { DisplayPanel } from "./display-panel";
import { VideoPanel } from "./video-panel";
import { PeerPanel, type PeerView } from "./peer-panel";
import { WifiPanel } from "./wifi-panel";
import { LiveSession } from "./live-session";
import { LocalTime, TimeAgo } from "@/components/term/motion";
import { Button, ButtonLink, EmptyState, Label, Led, Panel, Tag, Textarea } from "@/components/term/primitives";
import { Tabs } from "@/components/term/tabs";
import { useToast } from "@/components/term/toast";
import { useLive } from "@/hooks/use-live";
import { cn } from "@/lib/cn";
import { compact } from "@/lib/format";
import type { Device, EventRow, Session } from "@/lib/types";

type Tab = "live" | "timeline" | "sessions" | "config" | "audio" | "display" | "video";

export function DeviceDetail({
  device: initial,
  events,
  sessions,
  peer = null,
}: {
  device: Device;
  events: EventRow[];
  sessions: Session[];
  peer?: PeerView;
}) {
  const [device, setDevice] = useState(initial);
  const [tab, setTab] = useState<Tab>("live");
  const [pending, start] = useTransition();
  const toast = useToast();
  const router = useRouter();
  const online = device.status === "online";
  // An attached agent never connects to us — we call it — so presence is not a thing it
  // has, and reporting a permanent "offline" would read like a fault.
  const isAgent = device.kind === "agent";
  // What the header lights up for. Driving the glow off `online` left a reachable
  // harness looking dead, since its status column is "offline" for ever.
  const lit = isAgent ? peer?.reach === "yes" : online;
  const agentState = !peer
    ? "attached agent, no endpoint set"
    : peer.reach === "yes"
      ? "attached agent, answering over HTTP"
      : peer.reach === "no"
        ? "attached agent, not answering"
        : "attached agent, not checked yet";

  useLive((msg) => {
    if (msg.kind === "presence" && msg.deviceId === device.id) {
      setDevice((d) => ({ ...d, status: msg.status, ip: msg.ip ?? d.ip, last_seen_at: msg.at }));
    }
    if (msg.kind === "event" && msg.event.device_id === device.id && msg.event.type === "chat") router.refresh();
    // The device changed a setting on its own screen; pick up the new values.
    if (msg.kind === "device" && msg.deviceId === device.id) router.refresh();
  });

  function disconnect() {
    start(async () => {
      const res = await disconnectDevice(device.id);
      toast(res.ok && res.wasOnline ? `${device.name}: connection closed` : `${device.name} was not connected`, res.ok && res.wasOnline ? "ok" : "info");
    });
  }

  return (
    <>
      <motion.header
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        className={cn("relative mb-5 overflow-hidden border bg-panel/80 p-4 sm:p-5", lit ? "border-phos/40" : "border-line")}
      >
        {lit && <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top_left,rgb(57_255_122/0.08),transparent_60%)]" />}
        <div className="relative flex flex-wrap items-start gap-4">
          <div className={cn("grid size-14 place-items-center border", lit ? "border-phos/50 text-phos shadow-[0_0_20px_rgb(57_255_122/0.15)]" : "border-line text-amber-dim")}>
            <DeviceKindIcon kind={device.kind} className="size-7" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[10px] uppercase tracking-[0.2em] text-amber-dim">
              <Link href="/devices" className="hover:text-amber hover:underline">
                devices
              </Link> / {device.kind}
            </p>
            <h1 className="font-display text-4xl leading-none text-amber glow">{device.name}</h1>
            <p className="mt-1 flex items-center gap-2 text-xs">
              {isAgent ? (
                <>
                  <Led on={lit} tone={!peer ? "err" : peer.reach === "no" ? "err" : lit ? "phos" : "amber"} label={agentState} />
                  <span className={cn(!peer || peer.reach === "no" ? "text-err" : lit ? "text-phos" : "text-muted")}>{agentState}</span>
                </>
              ) : (
                <>
                  <Led on={online} />
                  <span className={online ? "text-phos" : "text-muted"}>{online ? "online" : "offline"}</span>
                  <span className="text-amber-faint">·</span>
                  <span className="text-muted">
                    last seen <TimeAgo iso={device.last_seen_at} />
                  </span>
                </>
              )}
            </p>
          </div>
          {!isAgent && (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" disabled title="Needs firmware support">
                reboot
              </Button>
              <Button size="sm" variant="danger" onClick={disconnect} disabled={!online || pending}>
                {pending ? "closing…" : "disconnect"}
              </Button>
            </div>
          )}
        </div>
        <dl className="relative mt-4 grid grid-cols-2 gap-3 border-t border-dashed border-line pt-4 text-[11px] sm:grid-cols-3 lg:grid-cols-6">
          <Meta label="id" value={device.id.slice(0, 8)} title={device.id} />
          <Meta label="host" value={device.hostname ? `${device.hostname}.local` : "—"} />
          <Meta label="ip" value={device.ip ?? "—"} />
          <Meta label="firmware" value={device.firmware ?? "—"} />
          <Meta label="hardware" value={device.hw ?? "—"} />
          <div>
            <dt className="text-amber-faint">registered</dt>
            <dd className="text-fg/80">
              <LocalTime iso={device.created_at} withDate />
            </dd>
          </div>
        </dl>
      </motion.header>

      <Tabs
        className="mb-4"
        active={tab}
        onChange={(t) => setTab(t as Tab)}
        tabs={[
          { id: "live", label: online ? "● live" : "live" },
          { id: "timeline", label: "timeline" },
          { id: "sessions", label: `sessions ${sessions.length}` },
          { id: "config", label: isAgent ? "endpoint" : "config" },
          // An attached agent has no microphone, no panel and no decoder, so the
          // hardware tabs would only offer things that cannot work.
          ...(isAgent
            ? []
            : [
                { id: "audio", label: "audio" },
                { id: "display", label: "display" },
                { id: "video", label: "video" },
              ]),
        ]}
      />

      <AnimatePresence mode="wait">
        <motion.div key={tab} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.15 }}>
          {tab === "live" && <LiveSession deviceId={device.id} deviceName={device.name} agent={isAgent && Boolean(peer)} />}
          {tab === "timeline" && (
            <Panel title="timeline" bodyClassName="p-0" actions={<ButtonLink size="sm" href={`/logs?device=${device.id}`}>filter in logs</ButtonLink>}>
              <LiveFeed initial={events} deviceId={device.id} height="h-[520px]" />
            </Panel>
          )}
          {tab === "sessions" && <Sessions sessions={sessions} />}
          {tab === "config" &&
            (isAgent ? (
              <PeerPanel deviceId={device.id} deviceName={device.name} peer={peer} />
            ) : (
              <ConfigEditor device={device} online={online} />
            ))}
          {tab === "audio" && <AudioPanel deviceId={device.id} deviceName={device.name} online={online} />}
          {tab === "display" && <DisplayPanel deviceId={device.id} deviceName={device.name} online={online} />}
          {tab === "video" && <VideoPanel deviceId={device.id} deviceName={device.name} online={online} />}
        </motion.div>
      </AnimatePresence>
    </>
  );
}

function Meta({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-amber-faint">{label}</dt>
      <dd className="truncate text-fg/80" title={title ?? value}>
        {value}
      </dd>
    </div>
  );
}

function Sessions({ sessions }: { sessions: Session[] }) {
  const [openId, setOpenId] = useState(sessions[0]?.id);
  const open = sessions.find((s) => s.id === openId);

  if (!sessions.length) {
    return (
      <Panel title="sessions">
        <EmptyState title="no conversations yet">When this device sends a chat message, the transcript lands here.</EmptyState>
      </Panel>
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
      <Panel title="sessions" bodyClassName="p-0">
        <ul className="max-h-[560px] overflow-y-auto">
          {sessions.map((s) => (
            <li key={s.id}>
              <button
                onClick={() => setOpenId(s.id)}
                className={cn(
                  "w-full cursor-pointer border-l-2 px-3 py-2 text-left transition-colors",
                  s.id === openId ? "border-amber bg-amber/[0.07]" : "border-transparent hover:bg-amber/[0.03]",
                )}
              >
                <p className={cn("truncate text-xs", s.id === openId ? "text-amber" : "text-fg")}>{s.title || "untitled"}</p>
                <p className="mt-0.5 flex justify-between text-[10px] text-muted">
                  <LocalTime iso={s.started_at} withDate />
                  <span>
                    {s.messages?.length ?? 0} msg · {compact(s.input_tokens + s.output_tokens)} tok
                  </span>
                </p>
              </button>
            </li>
          ))}
        </ul>
      </Panel>

      <Panel title={open?.title || "transcript"} actions={open?.model && <Tag tone="muted">{open.model}</Tag>}>
        <div className="max-h-[520px] space-y-3 overflow-y-auto pr-1">
          {open?.messages?.map((m, i) => (
            <motion.div
              key={m.id}
              initial={{ opacity: 0, x: m.role === "user" ? -6 : 6 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: Math.min(i, 12) * 0.03 }}
              className="text-xs leading-relaxed"
            >
              <p className="mb-0.5 text-[10px] uppercase tracking-[0.14em]">
                <span className={m.role === "user" ? "text-info" : "text-phos"}>{m.role === "user" ? "device" : "ai-term"}</span>
                <span className="text-amber-faint">
                  {" "}
                  · <LocalTime iso={m.created_at} />
                  {m.tokens ? ` · ${m.tokens} tok` : ""}
                </span>
              </p>
              <p className={cn("whitespace-pre-wrap border-l pl-3", m.role === "user" ? "border-info/40 text-fg" : "border-phos/40 text-fg/90")}>
                {m.role === "user" && <span className="text-amber-dim">&gt; </span>}
                {m.content}
              </p>
            </motion.div>
          ))}
        </div>
      </Panel>
    </div>
  );
}

// The settings the firmware knows about, mirroring the table in
// components/settings/settings.c. Kept deliberately in step with it: the device
// clamps everything it is sent, so a range that drifts here is a slider that stops
// short rather than a broken device.
const SETTINGS: { key: string; label: string; min: number; max: number; step: number; unit: string; bool?: boolean }[] = [
  { key: "display_brightness", label: "display brightness", min: 5, max: 100, step: 5, unit: "%" },
  { key: "led_brightness", label: "status led", min: 0, max: 100, step: 10, unit: "%" },
  { key: "volume", label: "speaker volume", min: 0, max: 100, step: 5, unit: "%" },
  { key: "mic_gain_shift", label: "mic gain shift", min: 8, max: 24, step: 1, unit: " (lower is louder)" },
  { key: "ui_sounds", label: "ui sounds", min: 0, max: 1, step: 1, unit: "", bool: true },
  { key: "dim_after_s", label: "dim after", min: 0, max: 600, step: 15, unit: "s" },
  { key: "blank_after_s", label: "blank after", min: 0, max: 1800, step: 60, unit: "s" },
];

function ConfigEditor({ device, online }: { device: Device; online: boolean }) {
  const stored = (device.config ?? {}) as Record<string, unknown>;
  const [values, setValues] = useState<Record<string, number>>(() =>
    Object.fromEntries(SETTINGS.map((s) => [s.key, Number(stored[s.key] ?? 0)])),
  );
  // Anything the firmware does not claim stays editable as raw JSON rather than
  // being silently dropped on the next save.
  const extras = Object.fromEntries(Object.entries(stored).filter(([k]) => !SETTINGS.some((s) => s.key === k)));
  const [text, setText] = useState(JSON.stringify(extras, null, 2));
  const [error, setError] = useState<string>();
  const [pending, start] = useTransition();
  const toast = useToast();

  let valid = true;
  try {
    JSON.parse(text);
  } catch {
    valid = false;
  }

  function save() {
    start(async () => {
      const merged = { ...JSON.parse(text), ...values };
      const res = await saveDeviceConfig(device.id, JSON.stringify(merged, null, 2));
      if (!res.ok) {
        setError(res.error);
        toast(res.error, "err");
        return;
      }
      setError(undefined);
      toast(res.pushed ? "saved and pushed to the device" : "saved (applies on next connect)");
    });
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
      <Panel
        title="settings"
        actions={
          <Button size="sm" variant="primary" onClick={save} disabled={!valid || pending}>
            {pending ? "saving…" : "save + push"}
          </Button>
        }
      >
        <div className="space-y-4">
          {SETTINGS.map((s) => (
            <div key={s.key} className="grid grid-cols-[150px_minmax(0,1fr)_70px] items-center gap-3">
              <Label>{s.label}</Label>
              <input
                type="range"
                min={s.min}
                max={s.max}
                step={s.step}
                value={values[s.key] ?? s.min}
                onChange={(e) => setValues((v) => ({ ...v, [s.key]: Number(e.target.value) }))}
                className="accent-phos"
              />
              <span className="text-right font-mono text-xs text-amber">
                {s.bool ? (values[s.key] ? "on" : "off") : `${values[s.key] ?? 0}${s.unit}`}
              </span>
            </div>
          ))}
        </div>
        {error && <p className="mt-3 text-xs text-err">!! {error}</p>}
      </Panel>
      <Panel title="how it's used">
        <div className="space-y-3 text-xs text-fg/80">
          <p>
            Sent in the <span className="text-amber">welcome</span> frame on connect, and pushed as a{" "}
            <span className="text-amber">config</span> frame when you save while it&apos;s online.
          </p>
          <p>
            The device sends the same keys back up whenever they change on its own settings screen, so these
            values are what the hardware actually has — not just the last thing that was pushed to it.
          </p>
          <Label hint="keys the firmware does not know about, kept as-is">other keys</Label>
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            spellCheck={false}
            className={cn("min-h-[120px] font-mono text-[11px]", !valid && "border-err/60 focus:border-err")}
          />
        </div>
      </Panel>
      {/* Wi-Fi is not a setting: settings are numbers and bools in both directions,
          and an SSID is a string. It has its own frames and its own panel. */}
      <div className="lg:col-start-2">
        <WifiPanel deviceId={device.id} online={online} />
      </div>
    </div>
  );
}

