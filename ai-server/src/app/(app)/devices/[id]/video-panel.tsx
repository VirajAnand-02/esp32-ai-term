"use client";

import { motion } from "motion/react";
import { useCallback, useEffect, useState } from "react";
import { Button, EmptyState, Input, Label, Panel, Select, Tag } from "@/components/term/primitives";
import { useToast } from "@/components/term/toast";
import { cn } from "@/lib/cn";

// Manual control of what plays on the device's panel. The agent has its own tools for
// this; the tab is for driving it directly.

type Caps = { online: boolean; capable: boolean; playing: boolean; youtube: boolean; capture: boolean };
type SourceKind = "url" | "file" | "youtube" | "screen" | "webcam";

export function VideoPanel({ deviceId, deviceName, online }: { deviceId: string; deviceName: string; online: boolean }) {
  const [caps, setCaps] = useState<Caps | null>(null);
  const [kind, setKind] = useState<SourceKind>("url");
  const [url, setUrl] = useState("");
  const [path, setPath] = useState("");
  const [device, setDevice] = useState("");
  const [mute, setMute] = useState(false);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const load = useCallback(() => {
    void fetch(`/api/devices/${deviceId}/video`, { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<Caps>) : null))
      .then((d) => d && setCaps(d));
  }, [deviceId]);

  useEffect(() => {
    let cancelled = false;
    void fetch(`/api/devices/${deviceId}/video`, { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<Caps>) : null))
      .then((d) => {
        if (d && !cancelled) setCaps(d);
      });
    return () => {
      cancelled = true;
    };
  }, [deviceId]);

  async function send(action: "play" | "stop") {
    setBusy(true);
    try {
      const res = await fetch(`/api/devices/${deviceId}/video`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, source: kind, url, path, device, mute }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; stopped?: boolean };
      if (!res.ok) toast(data.error ?? "that did not start", "err");
      else if (action === "play") toast(`playing on ${deviceName}${mute ? " (silent)" : ""}`);
      else toast(data.stopped ? "stopped" : "nothing was playing", "info");
      load();
    } finally {
      setBusy(false);
    }
  }

  if (!caps) {
    return (
      <Panel title="video">
        <p className="py-8 text-center text-xs text-amber-dim">
          asking the device<span className="animate-blink">_</span>
        </p>
      </Panel>
    );
  }

  if (!online || !caps.capable) {
    return (
      <Panel title="video">
        <EmptyState title={online ? "this firmware cannot play video" : `${deviceName} is offline`}>
          {online
            ? "The device did not advertise the video capability in its hello. Flash firmware with the video player built in."
            : "Bring the device online to play something on it."}
        </EmptyState>
      </Panel>
    );
  }

  const needsUrl = kind === "url" || kind === "youtube";
  const ready = kind === "screen" || (needsUrl ? url.trim() : kind === "file" ? path.trim() : device.trim());

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_300px]">
      <div className="grid min-w-0 content-start gap-4">
        <Panel title="play" actions={caps.playing && <Tag tone="phos">playing</Tag>}>
          <div className="grid gap-3">
            <div>
              <Label>source</Label>
              <Select value={kind} onChange={(e) => setKind(e.target.value as SourceKind)}>
                <option value="url">a video url</option>
                <option value="file">a file on the server</option>
                <option value="youtube" disabled={!caps.youtube}>
                  youtube{caps.youtube ? "" : " — yt-dlp not installed"}
                </option>
                <option value="screen" disabled={!caps.capture}>
                  this screen{caps.capture ? "" : " — not available here"}
                </option>
                <option value="webcam" disabled={!caps.capture}>
                  a webcam{caps.capture ? "" : " — not available here"}
                </option>
              </Select>
            </div>

            {needsUrl && (
              <div>
                <Label>{kind === "youtube" ? "youtube link" : "url"}</Label>
                <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" />
              </div>
            )}
            {kind === "file" && (
              <div>
                <Label hint="a path the server can read">file</Label>
                <Input value={path} onChange={(e) => setPath(e.target.value)} placeholder="C:/clips/demo.mp4" />
              </div>
            )}
            {kind === "webcam" && (
              <div>
                <Label hint="the DirectShow device name">webcam</Label>
                <Input value={device} onChange={(e) => setDevice(e.target.value)} placeholder="Integrated Camera" />
              </div>
            )}

            <button
              type="button"
              onClick={() => setMute((m) => !m)}
              className="group flex w-fit cursor-pointer items-center gap-2 text-left text-xs"
            >
              <span
                className={cn(
                  "grid size-4 shrink-0 place-items-center border transition-colors",
                  mute ? "border-phos text-phos" : "border-line text-transparent group-hover:border-amber/60",
                )}
              >
                x
              </span>
              <span className={mute ? "text-fg" : "text-muted group-hover:text-fg"}>play without sound</span>
              <span className="text-[11px] text-amber-faint">
                a little smoother (measured 10.4 fps against 9.8), and no sound to distort
              </span>
            </button>

            <div className="flex flex-wrap items-center gap-2">
              <Button variant="primary" size="sm" disabled={busy || !ready} onClick={() => send("play")}>
                {busy ? "starting…" : "play"}
              </Button>
              <Button variant="danger" size="sm" disabled={busy} onClick={() => send("stop")}>
                stop
              </Button>
              {caps.playing && (
                <motion.span
                  className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.14em] text-phos"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                >
                  <span className="size-1.5 animate-breathe rounded-full bg-phos" /> on the panel
                </motion.span>
              )}
            </div>
          </div>
        </Panel>
      </div>

      <div className="grid min-w-0 content-start gap-4">
        <Panel title="what to expect" className="min-w-0">
          <ul className="space-y-1.5 text-[11px] text-amber-faint">
            <li>
              <span className="text-fg">240x240, about 12 fps.</span> The panel is the limit: a full frame takes
              ~50 ms to push at 20 MHz, so this is close to flat out.
            </li>
            <li>
              <span className="text-fg">Sound is 22.05 kHz mono</span> through the amplifier, and it is the clock —
              video frames are dropped rather than let the audio stutter. Turning it off frees that task and the
              picture runs noticeably smoother.
            </li>
            <li>Anything ffmpeg can read works; it is cropped to a square here before it is sent.</li>
            <li>Busy, detailed footage decodes more slowly than flat cartoon-like footage.</li>
          </ul>
        </Panel>

        <Panel title="capture" className="min-w-0">
          <p className="text-[11px] text-amber-faint">
            {caps.capture
              ? "Screen and webcam capture run on the machine hosting this server, so they only make sense while it runs locally."
              : "Screen and webcam capture need the server on a Windows machine; they are unavailable on this host."}
          </p>
        </Panel>
      </div>
    </div>
  );
}
