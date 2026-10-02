"use client";

import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { LocalTime } from "@/components/term/motion";
import { Button, EmptyState, Panel, Select, Tag } from "@/components/term/primitives";
import { Tabs } from "@/components/term/tabs";
import { useToast } from "@/components/term/toast";
import { useLive } from "@/hooks/use-live";
import { cn } from "@/lib/cn";
import type { AudioClip } from "@/lib/types";

const DURATIONS = [3, 5, 10, 15, 30];

type Snapshot = { clips?: AudioClip[]; canRecord?: boolean; recording?: boolean; canTranscribe?: boolean };

async function fetchSnapshot(deviceId: string): Promise<Snapshot | null> {
  const res = await fetch(`/api/devices/${deviceId}/live`, { cache: "no-store" });
  return res.ok ? ((await res.json()) as Snapshot) : null;
}

function bytes(n: number) {
  return n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;
}

export function AudioPanel({ deviceId, deviceName, online }: { deviceId: string; deviceName: string; online: boolean }) {
  const [clips, setClips] = useState<AudioClip[]>([]);
  const [kind, setKind] = useState<"clips" | "notes">("clips");
  const [canRecord, setCanRecord] = useState(false);
  const [canTranscribe, setCanTranscribe] = useState(false);
  const [transcribing, setTranscribing] = useState<string | null>(null);
  const [seconds, setSeconds] = useState(5);
  const [recording, setRecording] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [playing, setPlaying] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const audio = useRef<HTMLAudioElement | null>(null);
  const toast = useToast();

  const apply = useCallback((data: Snapshot) => {
    setClips(data.clips ?? []);
    setCanRecord(Boolean(data.canRecord));
    setCanTranscribe(Boolean(data.canTranscribe));
    setRecording(Boolean(data.recording));
    setLoaded(true);
  }, []);

  const load = useCallback(() => {
    void fetchSnapshot(deviceId).then((data) => data && apply(data));
  }, [deviceId, apply]);

  useEffect(() => {
    let cancelled = false;
    void fetchSnapshot(deviceId).then((data) => {
      if (data && !cancelled) apply(data);
    });
    return () => {
      cancelled = true;
    };
  }, [deviceId, apply]);

  useLive((msg) => {
    if (msg.kind !== "session" || msg.deviceId !== deviceId) return;
    if (msg.frame.type === "clip") {
      const clip = msg.frame.clip;
      setClips((c) => [clip, ...c.filter((x) => x.id !== clip.id)]);
      setRecording(false);
    } else if (msg.frame.type === "audio") {
      setRecording(msg.frame.state === "recording");
    } else if (msg.frame.type === "access") {
      load();
    }
  });

  async function record() {
    setRecording(true);
    const res = await fetch(`/api/devices/${deviceId}/record`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seconds }),
    });
    setRecording(false);
    if (!res.ok) {
      toast((await res.json().catch(() => ({}))).error ?? "recording failed", "err");
      return;
    }
    const { clip } = await res.json();
    if (clip) toast(`recorded ${clip.seconds.toFixed(1)}s from ${deviceName}`);
    load();
  }

  // One element for every clip: switching sources mid-play would otherwise reject
  // the pending play() promise with an AbortError.
  function player() {
    if (!audio.current) {
      const el = new Audio();
      el.onended = () => {
        setPlaying(null);
        setProgress(0);
      };
      el.onpause = () => setPlaying(null);
      el.ontimeupdate = () => setProgress(el.duration ? el.currentTime / el.duration : 0);
      audio.current = el;
    }
    return audio.current;
  }

  function play(clip: AudioClip) {
    const el = player();
    if (playing === clip.id) {
      el.pause();
      return;
    }
    const src = `/api/clips/${clip.id}`;
    if (!el.src.endsWith(src)) {
      el.pause();
      el.src = src;
    }
    el.currentTime = 0;
    setProgress(0);
    setPlaying(clip.id);
    el.play().catch((err: DOMException) => {
      setPlaying(null);
      // AbortError just means another clip started, or the user hit pause.
      if (err.name !== "AbortError") toast(`could not play that clip: ${err.message}`, "err");
    });
  }

  // Groq (whisper-large-v3-turbo). The text is kept on the clip, so this runs once.
  async function transcribeClip(clip: AudioClip) {
    setTranscribing(clip.id);
    try {
      const res = await fetch(`/api/clips/${clip.id}/transcribe`, { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as { clip?: AudioClip; error?: string };
      if (!res.ok || !data.clip) return toast(data.error ?? "could not transcribe that clip", "err");
      const updated = data.clip;
      setClips((c) => c.map((x) => (x.id === updated.id ? updated : x)));
      if (!updated.transcript) toast("nothing was said in that clip", "info");
    } finally {
      setTranscribing(null);
    }
  }

  async function remove(clip: AudioClip) {
    if (playing === clip.id) audio.current?.pause();
    const res = await fetch(`/api/clips/${clip.id}`, { method: "DELETE" });
    if (!res.ok) return toast("could not delete that clip", "err");
    setClips((c) => c.filter((x) => x.id !== clip.id));
  }

  useEffect(() => () => audio.current?.pause(), []);

  const notes = clips.filter((c) => c.source === "note");
  const recordings = clips.filter((c) => c.source !== "note");
  const shown = kind === "notes" ? notes : recordings;

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_300px]">
      <Panel title={`audio // ${shown.length}`} bodyClassName="p-0">
        <Tabs
          className="px-2"
          active={kind}
          onChange={(id) => setKind(id as "clips" | "notes")}
          tabs={[
            { id: "clips", label: `clips ${recordings.length}` },
            { id: "notes", label: `voice notes ${notes.length}` },
          ]}
        />
        {!loaded ? (
          <p className="px-4 py-8 text-center text-xs text-amber-dim">
            loading clips<span className="animate-blink">_</span>
          </p>
        ) : shown.length === 0 ? (
          <EmptyState title={kind === "notes" ? "no voice notes yet" : "nothing recorded yet"}>
            {kind === "notes"
              ? `Double tap the mic button on ${deviceName} to start one, then tap once to stop.`
              : canRecord
                ? `Hit record to capture a few seconds from ${deviceName}'s microphone.`
                : "This device has no microphone tool."}
          </EmptyState>
        ) : (
          <ul className="divide-y divide-dashed divide-line">
            <AnimatePresence initial={false}>
              {shown.map((clip) => {
                const active = playing === clip.id;
                return (
                  <motion.li
                    key={clip.id}
                    layout
                    initial={{ opacity: 0, y: -6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, height: 0 }}
                    className="group flex items-center gap-3 px-3 py-2.5"
                  >
                    <Button size="sm" variant={active ? "primary" : "ghost"} onClick={() => play(clip)} aria-label={active ? "pause" : "play"}>
                      {active ? "❚❚" : "▶"}
                    </Button>

                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2 text-xs">
                        <span className="text-fg">{clip.seconds.toFixed(1)}s</span>
                        <Tag tone={clip.source === "agent" ? "phos" : "muted"}>{clip.source}</Tag>
                        <span className="truncate text-amber-faint">
                          <LocalTime iso={clip.created_at} withDate /> · {bytes(clip.bytes)} · {(clip.sample_rate / 1000).toFixed(0)} kHz
                        </span>
                        {(clip.peak ?? 0) >= 0.99 && (
                          <span title="clipped: raise mic_gain_shift in the device config">
                            <Tag tone="warn" className="shrink-0">
                              hot
                            </Tag>
                          </span>
                        )}
                      </div>
                      {/* progress while playing, loudness otherwise */}
                      <div className="mt-1 h-1.5 w-full bg-line/60">
                        <div
                          className={cn("h-full transition-[width]", active ? "bg-amber" : "bg-phos/60")}
                          style={{ width: `${Math.round((active ? progress : (clip.peak ?? 0)) * 100)}%` }}
                        />
                      </div>
                      {clip.note && <p className="mt-0.5 truncate text-[11px] text-muted">{clip.note}</p>}
                      {clip.transcript ? (
                        <p className="mt-1 border-l border-phos/40 pl-2 text-[11px] text-fg/85">
                          <span className="text-phos">“</span>
                          {clip.transcript}
                          <span className="text-phos">”</span>
                        </p>
                      ) : (
                        canTranscribe && (
                          <button
                            onClick={() => transcribeClip(clip)}
                            disabled={transcribing !== null}
                            className="mt-0.5 cursor-pointer text-[11px] text-muted transition-colors hover:text-phos disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {transcribing === clip.id ? "transcribing…" : "transcribe"}
                          </button>
                        )
                      )}
                    </div>

                    <span className="hidden w-16 shrink-0 text-right text-[10px] text-amber-faint sm:inline">
                      peak {Math.round((clip.peak ?? 0) * 100)}%
                    </span>
                    <a
                      href={`/api/clips/${clip.id}`}
                      download
                      className="shrink-0 text-[11px] text-muted opacity-0 transition-opacity hover:text-amber group-hover:opacity-100"
                    >
                      save
                    </a>
                    <button
                      onClick={() => remove(clip)}
                      className="shrink-0 cursor-pointer text-[11px] text-muted opacity-0 transition-opacity hover:text-err group-hover:opacity-100"
                    >
                      rm
                    </button>
                  </motion.li>
                );
              })}
            </AnimatePresence>
          </ul>
        )}
      </Panel>

      <div className="grid content-start gap-4">
        <Panel title="microphone">
          {canRecord ? (
            <div className="space-y-3">
              <label className="block">
                <span className="mb-1 block text-[11px] uppercase tracking-[0.16em] text-muted">
                  <span className="text-amber-dim">$ </span>length
                </span>
                <Select value={seconds} onChange={(e) => setSeconds(Number(e.target.value))} disabled={recording}>
                  {DURATIONS.map((d) => (
                    <option key={d} value={d}>
                      {d} seconds
                    </option>
                  ))}
                </Select>
              </label>
              <Button variant={recording ? "danger" : "primary"} className="w-full" onClick={record} disabled={!online || recording}>
                {recording ? "recording…" : "● record"}
              </Button>
              {recording && (
                <div className="h-1 w-full overflow-hidden bg-line/60">
                  <motion.div
                    key={seconds}
                    className="h-full bg-err"
                    initial={{ width: "0%" }}
                    animate={{ width: "100%" }}
                    transition={{ duration: seconds, ease: "linear" }}
                  />
                </div>
              )}
              <p className="text-[11px] text-amber-faint">
                {online
                  ? "Captured on the device and uploaded as a WAV. The agent can also record with the record_audio tool."
                  : `${deviceName} is offline; older clips still play.`}
              </p>
            </div>
          ) : (
            <p className="text-xs text-muted">
              This device doesn&apos;t offer a microphone tool. Clips appear here once its firmware advertises{" "}
              <span className="text-amber">record_audio</span>.
            </p>
          )}
        </Panel>

        <Panel title="playback">
          <p className="text-xs text-muted">
            Clips are stored as 16-bit PCM WAV in the private storage bucket and streamed through this server, so the bucket
            stays closed to the internet.
          </p>
          <p className="mt-2 text-[11px] text-amber-faint">
            {canTranscribe
              ? "Speech to text runs on Groq (whisper-large-v3-turbo). The mic button in the live tab records, transcribes and prompts in one go."
              : "Set GROQ_API_KEY to turn on speech to text."}
          </p>
        </Panel>
      </div>
    </div>
  );
}
