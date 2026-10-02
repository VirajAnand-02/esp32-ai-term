"use client";

import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { LocalTime } from "@/components/term/motion";
import { Button, EmptyState, Panel, Tag } from "@/components/term/primitives";
import { useToast } from "@/components/term/toast";
import { useLive } from "@/hooks/use-live";
import { cn } from "@/lib/cn";
import type { Access, Message, Origin, ToolCallRow } from "@/lib/types";

type Snapshot = {
  online: boolean;
  access: Access | null;
  protocol: number | null;
  tools: { name: string; risk: string; description: string }[];
  running: { origin: Origin } | null;
  session: { id: string; title: string | null; started_at: string; model: string | null } | null;
  messages: Message[];
  toolCalls: ToolCallRow[];
  canRecord: boolean;
  canTranscribe: boolean;
};

type Item =
  | { kind: "user"; key: string; text: string; origin: Origin }
  | { kind: "assistant"; key: string; text: string; streaming: boolean; footer?: string }
  | { kind: "tool"; key: string; call: ToolCallRow }
  | { kind: "error"; key: string; text: string };

const LEVEL_TONE: Record<string, "info" | "phos" | "warn" | "err"> = { readonly: "info", standard: "phos", trusted: "warn", yolo: "err" };
const RISK_TONE: Record<string, "muted" | "info" | "phos" | "warn" | "err"> = {
  info: "muted",
  read: "info",
  create: "phos",
  modify: "warn",
  destructive: "err",
  exec: "warn",
};

let seq = 0;
const key = () => `k${++seq}`;

function toItems(snap: Snapshot): Item[] {
  const rows: { at: string; item: Item }[] = [
    ...snap.messages.map((m) => ({
      at: m.created_at,
      item:
        m.role === "user"
          ? ({ kind: "user", key: `m${m.id}`, text: m.content, origin: m.origin ?? "device" } as Item)
          : ({ kind: "assistant", key: `m${m.id}`, text: m.content, streaming: false } as Item),
    })),
    ...snap.toolCalls.map((c) => ({ at: c.created_at, item: { kind: "tool", key: c.id, call: c } as Item })),
  ];
  return rows.sort((a, b) => a.at.localeCompare(b.at)).map((r) => r.item);
}

async function fetchSnapshot(deviceId: string): Promise<Snapshot | null> {
  const res = await fetch(`/api/devices/${deviceId}/live`, { cache: "no-store" });
  return res.ok ? ((await res.json()) as Snapshot) : null;
}

function summarize(call: ToolCallRow): string {
  const a = call.args as Record<string, unknown>;
  if (call.name === "run_command") return `$ ${a.command ?? ""}`;
  if (call.name === "move_path") return `${a.source} → ${a.destination}`;
  const target = a.path ?? a.root;
  return target ? `${target}${a.pattern ? ` ${JSON.stringify(a.pattern)}` : ""}` : "";
}

// `agent` means an attached harness with an endpoint set: there is no websocket and so
// never any presence, but it can still be asked things over HTTP. Everything that was
// gated on `snap.online` has to consult `canSend` instead, or the composer stays dead.
export function LiveSession({ deviceId, deviceName, agent = false }: { deviceId: string; deviceName: string; agent?: boolean }) {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [running, setRunning] = useState(false);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [listenSecs, setListenSecs] = useState(6);
  const [listening, setListening] = useState(0); // seconds left on the capture
  const scroller = useRef<HTMLDivElement>(null);
  const toast = useToast();

  const apply = useCallback((data: Snapshot) => {
    setSnap(data);
    setItems(toItems(data));
    setRunning(Boolean(data.running));
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

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [items]);

  useLive((msg) => {
    if (msg.kind === "presence" && msg.deviceId === deviceId) {
      load();
      return;
    }
    if (msg.kind !== "session" || msg.deviceId !== deviceId) return;
    const f = msg.frame;
    switch (f.type) {
      case "chat.user":
        setRunning(true);
        setSnap((s) => (s && !s.session ? { ...s, session: { id: f.session_id, title: f.text, started_at: new Date().toISOString(), model: null } } : s));
        setItems((xs) => [...xs, { kind: "user", key: key(), text: f.text, origin: f.origin }]);
        break;
      case "chat.delta":
        setItems((xs) => {
          const last = xs.at(-1);
          if (last?.kind === "assistant" && last.streaming) return [...xs.slice(0, -1), { ...last, text: last.text + f.text }];
          return [...xs, { kind: "assistant", key: key(), text: f.text, streaming: true }];
        });
        break;
      case "tool":
        setItems((xs) => {
          const i = xs.findIndex((x) => x.kind === "tool" && x.call.id === f.call.id);
          if (i >= 0) return xs.map((x, j) => (j === i ? { ...x, call: f.call } as Item : x));
          // A tool call closes the text stretch before it.
          const closed = xs.map((x) => (x.kind === "assistant" && x.streaming ? { ...x, streaming: false } : x));
          return [...closed, { kind: "tool", key: f.call.id, call: f.call }];
        });
        if (f.call.status === "awaiting_approval") toast(`${deviceName}: ${f.call.name} needs approval`, "info");
        break;
      case "chat.done":
        setRunning(false);
        setItems((xs) => {
          const footer = f.aborted ? "aborted" : `${f.usage.input} in · ${f.usage.output} out`;
          const last = xs.at(-1);
          if (last?.kind === "assistant") return [...xs.slice(0, -1), { ...last, streaming: false, footer }];
          return f.aborted ? [...xs, { kind: "error", key: key(), text: "turn aborted" }] : xs;
        });
        break;
      case "error":
        setRunning(false);
        setItems((xs) => [
          ...xs.map((x) => (x.kind === "assistant" && x.streaming ? { ...x, streaming: false } : x)),
          { kind: "error", key: key(), text: f.msg },
        ]);
        break;
      case "session":
        setItems([]);
        setSnap((s) => (s ? { ...s, session: null } : s));
        break;
      case "access":
        load();
        break;
    }
  });

  async function post(path: string, body?: unknown) {
    const res = await fetch(`/api/devices/${deviceId}/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const { error } = await res.json().catch(() => ({ error: res.statusText }));
      toast(error ?? "request failed", "err");
      return false;
    }
    return true;
  }

  // Push to talk: the device records, Groq turns it into text, and the text is
  // sent as a prompt. The turn itself arrives over SSE like any other.
  async function listen() {
    setListening(listenSecs);
    const tick = setInterval(() => setListening((n) => (n > 1 ? n - 1 : 0)), 1000);
    try {
      const res = await fetch(`/api/devices/${deviceId}/listen`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ seconds: listenSecs, prompt: true }),
      });
      const data = (await res.json().catch(() => ({}))) as { text?: string; prompted?: boolean; reason?: string; error?: string };
      if (!res.ok) toast(data.error ?? "listening failed", "err");
      else if (!data.text) toast(data.reason ?? "nothing was picked up", "info");
      else if (!data.prompted) toast(`heard "${data.text}" but ${data.reason ?? "did not send it"}`, "info");
    } catch (err) {
      toast((err as Error).message, "err");
    } finally {
      clearInterval(tick);
      setListening(0);
    }
  }

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    setSending(true);
    if (agent) await askAgent(t);
    else if (await post("prompt", { text: t })) setText("");
    setSending(false);
  }

  // An attached agent has no session to stream, so the exchange is appended here. The
  // tool_calls row the server writes still arrives over SSE and shows alongside, which
  // is also how a handed-off answer turns up once it lands.
  async function askAgent(t: string) {
    setItems((xs) => [...xs, { kind: "user", key: key(), text: t, origin: "web" }]);
    setText("");
    const res = await fetch(`/api/devices/${deviceId}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: t }),
    });
    const data = (await res.json().catch(() => null)) as
      | { ok?: boolean; answer?: string; handedOff?: boolean; jobId?: string; error?: string }
      | null;
    if (!res.ok) {
      const msg = data?.error ?? res.statusText;
      setItems((xs) => [...xs, { kind: "error", key: key(), text: msg }]);
      toast(msg, "err");
      return;
    }
    if (data?.handedOff) {
      setItems((xs) => [
        ...xs,
        { kind: "assistant", key: key(), text: `still working — job ${(data.jobId ?? "").slice(0, 8)}. The answer lands here when it arrives.`, streaming: false },
      ]);
      return;
    }
    setItems((xs) => [...xs, { kind: "assistant", key: key(), text: data?.answer ?? "", streaming: false }]);
  }

  if (!snap) {
    return (
      <Panel title="live session">
        <p className="py-8 text-center text-xs text-amber-dim">
          attaching to session<span className="animate-blink">_</span>
        </p>
      </Panel>
    );
  }

  const level = snap.access?.level;
  const remoteOk = Boolean(snap.access?.remote_approval);
  const canSend = agent || snap.online;

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_300px]">
      <Panel
        title={
          <>
            {agent ? "asks" : snap.online ? "live session" : "last session"}{" "}
            <span className="text-amber-faint">{snap.session ? snap.session.id.slice(0, 8) : "new"}</span>
          </>
        }
        bodyClassName="p-0"
        actions={
          snap.online && (
            <>
              {running && (
                <span className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.14em] text-phos">
                  <span className="size-1.5 animate-breathe rounded-full bg-phos text-phos" /> working
                </span>
              )}
              <Button size="sm" variant="danger" onClick={() => post("abort")} disabled={!running}>
                abort
              </Button>
              <Button size="sm" onClick={() => post("session")} disabled={running}>
                new
              </Button>
            </>
          )
        }
      >
        <div ref={scroller} className="h-[calc(100dvh-420px)] min-h-[340px] space-y-2 overflow-y-auto px-4 py-3 text-[13px] leading-relaxed">
          {!snap.online && !agent && (
            <p className="text-xs text-muted">{deviceName} is offline. This is its most recent session, read-only.</p>
          )}
          {items.length === 0 && (
            <EmptyState title={agent ? "nothing asked yet" : snap.online ? "session is empty" : "no sessions yet"}>
              {agent
                ? `Anything typed here is handed to ${deviceName} as one self-contained task. It starts fresh each time — it is sent no history.`
                : snap.online
                  ? `Anything typed here runs on ${deviceName}, and shows up on its screen too.`
                  : null}
            </EmptyState>
          )}
          <AnimatePresence initial={false}>
            {items.map((item) => (
              <motion.div key={item.key} layout="position" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }}>
                {item.kind === "user" && (
                  <p className="text-fg">
                    <span className={cn("mr-1 text-[10px] uppercase", item.origin === "web" ? "text-warn" : "text-info")}>[{item.origin}]</span>
                    <span className="text-phos">you</span>
                    <span className="text-muted"> › </span>
                    {item.text}
                  </p>
                )}
                {item.kind === "assistant" && (
                  <div className="border-l border-amber/30 pl-3">
                    <p className={cn("whitespace-pre-wrap text-amber glow", item.streaming && "cursor")}>{item.text}</p>
                    {item.footer && <p className="text-[10px] text-amber-faint">{item.footer}</p>}
                  </div>
                )}
                {item.kind === "tool" && <ToolCard call={item.call} remoteOk={remoteOk && snap.online} onDecide={(approved) => post("approve", { call_id: item.call.id, approved })} />}
                {item.kind === "error" && <p className="text-xs text-err">!! {item.text}</p>}
              </motion.div>
            ))}
          </AnimatePresence>
        </div>

        <form onSubmit={send} className="flex items-center gap-2 border-t border-line bg-bg-2/60 px-4 py-2.5">
          <span className="shrink-0 text-xs">
            <span className="text-warn">[web]</span> <span className="text-phos">{deviceName}</span>
            <span className="text-muted">:~$</span>
          </span>
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={!canSend || running || sending || listening > 0}
            placeholder={
              listening > 0
                ? `listening on ${deviceName}…`
                : !canSend
                  ? "device is offline"
                  : agent
                    ? `ask ${deviceName} to do something…`
                    : running
                      ? "agent is working… (abort to interrupt)"
                      : `drive ${deviceName}… or hit the mic`
            }
            className="min-w-0 flex-1 bg-transparent text-[13px] text-amber outline-none placeholder:text-amber-faint"
          />
          {snap.canRecord && (
            <>
              <button
                type="button"
                title="how long to listen for"
                onClick={() => setListenSecs((n) => (n === 4 ? 6 : n === 6 ? 10 : n === 10 ? 15 : 4))}
                disabled={listening > 0}
                className="shrink-0 cursor-pointer px-1 text-[10px] tabular-nums text-amber-faint hover:text-amber disabled:cursor-not-allowed"
              >
                {listenSecs}s
              </button>
              <button
                type="button"
                onClick={listen}
                disabled={!snap.online || running || sending || listening > 0 || !snap.canTranscribe}
                title={snap.canTranscribe ? `record ${listenSecs}s on the device and send what was said` : "GROQ_API_KEY is not set"}
                className={cn(
                  "relative grid size-7 shrink-0 cursor-pointer place-items-center border transition-colors",
                  listening > 0 ? "border-err text-err" : "border-line text-amber-dim hover:border-amber/60 hover:text-amber",
                  "disabled:cursor-not-allowed disabled:opacity-40",
                )}
              >
                {listening > 0 && <span className="absolute inset-0 animate-ping bg-err/20" />}
                <span className="relative text-[11px] tabular-nums">{listening > 0 ? listening : "●"}</span>
              </button>
            </>
          )}
          <Button type="submit" size="sm" variant="primary" disabled={!canSend || running || sending || listening > 0 || !text.trim()}>
            send
          </Button>
        </form>
      </Panel>

      <div className="grid content-start gap-4">
        <Panel title="access">
          {level ? (
            <div className="space-y-2 text-xs">
              <div className="flex items-center justify-between">
                <span className="text-amber-faint">level</span>
                <Tag tone={LEVEL_TONE[level] ?? "muted"} className={cn(level === "yolo" && "animate-pulse")}>
                  {level}
                </Tag>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-amber-faint">approve from web</span>
                <span className={remoteOk ? "text-phos" : "text-muted"}>{remoteOk ? "allowed" : "device only"}</span>
              </div>
              <p className="text-[11px] text-amber-faint">
                Set on the device ({"/level"} in aiterm). The dashboard can see it but never change it.
              </p>
            </div>
          ) : (
            <p className="text-xs text-muted">{snap.online ? "This client doesn't offer tools (plain chat)." : "offline"}</p>
          )}
        </Panel>
        <Panel title={`tools // ${snap.tools.length}`}>
          {snap.tools.length ? (
            <ul className="space-y-1.5 text-xs">
              {snap.tools.map((t) => (
                <li key={t.name} className="flex items-center justify-between gap-2" title={t.description}>
                  <span className="truncate text-fg">{t.name}</span>
                  <Tag tone={RISK_TONE[t.risk] ?? "muted"}>{t.risk}</Tag>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted">none advertised</p>
          )}
        </Panel>
      </div>
    </div>
  );
}

const STATUS: Record<ToolCallRow["status"], { icon: string; tone: string; label: string }> = {
  running: { icon: "…", tone: "text-amber", label: "running" },
  awaiting_approval: { icon: "?", tone: "text-warn", label: "needs approval" },
  ok: { icon: "✓", tone: "text-phos", label: "done" },
  error: { icon: "✗", tone: "text-err", label: "failed" },
  denied: { icon: "⊘", tone: "text-err", label: "denied" },
};

function ToolCard({ call, remoteOk, onDecide }: { call: ToolCallRow; remoteOk: boolean; onDecide: (approved: boolean) => Promise<boolean> }) {
  const [open, setOpen] = useState(false);
  const [deciding, setDeciding] = useState(false);
  const s = STATUS[call.status];
  const awaiting = call.status === "awaiting_approval";

  async function decide(approved: boolean) {
    setDeciding(true);
    await onDecide(approved);
    setDeciding(false);
  }

  return (
    <div
      className={cn(
        "ml-3 border px-3 py-2 text-xs transition-colors",
        awaiting ? "animate-pulse border-warn/70 bg-warn/[0.06] [animation-duration:2.4s]" : "border-line bg-bg-2/50",
        call.status === "denied" && "border-err/40",
      )}
    >
      <button onClick={() => setOpen((o) => !o)} className="flex w-full cursor-pointer items-center gap-2 text-left">
        <span className={s.tone}>⚙ {s.icon}</span>
        <span className={cn("font-bold", s.tone)}>{call.name}</span>
        {call.risk && <Tag tone={RISK_TONE[call.risk] ?? "muted"}>{call.risk}</Tag>}
        <span className="min-w-0 flex-1 truncate text-fg/80">{summarize(call)}</span>
        <span className={cn("shrink-0 text-[10px] uppercase tracking-[0.12em]", s.tone)}>
          {s.label}
          {call.decided_by && ["web", "device"].includes(call.decided_by) && call.status !== "awaiting_approval" && (
            <span className="text-amber-faint"> · by {call.decided_by}</span>
          )}
        </span>
        <span className="text-amber-faint">{open ? "▾" : "▸"}</span>
      </button>

      {awaiting && (
        <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-dashed border-warn/40 pt-2">
          <span className="flex-1 text-warn">{call.reason ?? "needs approval"}</span>
          {remoteOk ? (
            <>
              <Button size="sm" variant="phos" disabled={deciding} onClick={() => decide(true)}>
                approve
              </Button>
              <Button size="sm" variant="danger" disabled={deciding} onClick={() => decide(false)}>
                deny
              </Button>
            </>
          ) : (
            <span className="text-[11px] text-muted">awaiting approval on the device</span>
          )}
        </div>
      )}
      {call.status === "denied" && call.output && <p className="mt-1 text-err/90">{call.output}</p>}

      {open && (
        <div className="mt-2 space-y-2 border-t border-dashed border-line pt-2">
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap text-[11px] text-amber-dim">{JSON.stringify(call.args, null, 2)}</pre>
          {call.output && call.status !== "denied" && (
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap text-[11px] text-fg/80">{call.output}</pre>
          )}
          <p className="text-[10px] text-amber-faint">
            <LocalTime iso={call.created_at} />
            {call.finished_at && (
              <>
                {" → "}
                <LocalTime iso={call.finished_at} />
              </>
            )}
          </p>
        </div>
      )}
    </div>
  );
}
