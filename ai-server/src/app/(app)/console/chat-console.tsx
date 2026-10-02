"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { AnimatePresence, motion } from "motion/react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { DeviceKindIcon } from "@/components/term/device-kind";
import { Button, Led, Panel, Tag } from "@/components/term/primitives";
import { useToast } from "@/components/term/toast";
import { useLive } from "@/hooks/use-live";
import { cn } from "@/lib/cn";
import { uuid } from "@/lib/format";
import type { Access, DeviceKind, ToolCallRow } from "@/lib/types";

const SUGGESTIONS = [
  "which devices are online, and what can each one do?",
  "summarise what happened across the fleet in the last hour",
  "check free disk space on every online computer",
  "ask each online device for its local time",
];

type FleetDevice = { id: string; name: string; kind: DeviceKind; online: boolean; busy: boolean; access: Access | null; tools: string[] };
type Fleet = { devices: FleetDevice[]; pending: ToolCallRow[] };

const LEVEL_TONE: Record<string, "info" | "phos" | "warn" | "err"> = { readonly: "info", standard: "phos", trusted: "warn", yolo: "err" };

const noopSubscribe = () => () => {};

function textOf(m: UIMessage) {
  return m.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
}

export function ChatConsole({ model, ready, missingKey }: { model: string; ready: boolean; missingKey?: string }) {
  // The id is random, so only render once hydrated to keep server and client HTML identical.
  const [sessionId, setSessionId] = useState(uuid);
  const hydrated = useSyncExternalStore(noopSubscribe, () => true, () => false);
  if (!hydrated) return <p className="text-xs text-amber-dim">opening tty<span className="animate-blink">_</span></p>;
  return <ChatSession key={sessionId} id={sessionId} model={model} ready={ready} missingKey={missingKey} onReset={() => setSessionId(uuid())} />;
}

function useFleet() {
  const [fleet, setFleet] = useState<Fleet>({ devices: [], pending: [] });

  const refresh = useCallback(() => {
    void fetch("/api/fleet", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((f: Fleet | null) => f && setFleet(f));
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/fleet", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((f: Fleet | null) => f && !cancelled && setFleet(f));
    return () => {
      cancelled = true;
    };
  }, []);

  useLive((msg) => {
    if (msg.kind === "presence") return refresh();
    if (msg.kind !== "session") return;
    const f = msg.frame;
    const setBusy = (busy: boolean) =>
      setFleet((s) => ({ ...s, devices: s.devices.map((d) => (d.id === msg.deviceId ? { ...d, busy } : d)) }));
    if (f.type === "chat.user") setBusy(true);
    else if (f.type === "chat.done" || f.type === "error") setBusy(false);
    else if (f.type === "access") refresh();
    else if (f.type === "tool") {
      setFleet((s) => {
        const others = s.pending.filter((p) => p.id !== f.call.id);
        return { ...s, pending: f.call.status === "awaiting_approval" ? [...others, f.call] : others };
      });
    }
  });

  return fleet;
}

function ChatSession({ id, model, ready, missingKey, onReset }: { id: string; model: string; ready: boolean; missingKey?: string; onReset: () => void }) {
  const { messages, sendMessage, status, stop, error } = useChat({
    id,
    transport: new DefaultChatTransport({ api: "/api/chat" }),
  });
  const fleet = useFleet();
  const [input, setInput] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [cursor, setCursor] = useState(-1);
  const scroller = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const busy = status === "submitted" || status === "streaming";
  const online = fleet.devices.filter((d) => d.online);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [messages, status]);

  function submit(text: string) {
    const t = text.trim();
    if (!t || busy || !ready) return;
    sendMessage({ text: t });
    setHistory((h) => [t, ...h].slice(0, 50));
    setCursor(-1);
    setInput("");
  }

  function mention(name: string) {
    setInput((v) => `${v}${v && !v.endsWith(" ") ? " " : ""}@${name} `);
    inputRef.current?.focus();
  }

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
      <Panel
        title={
          <>
            master // session <span className="text-amber-faint">{id.slice(0, 8)}</span>
          </>
        }
        bodyClassName="p-0"
        actions={
          <>
            <Tag tone={ready ? "phos" : "err"}>{model}</Tag>
            <Button size="sm" onClick={onReset} disabled={busy}>
              new
            </Button>
          </>
        }
      >
        <div
          ref={scroller}
          className="h-[calc(100dvh-300px)] min-h-[380px] space-y-3 overflow-y-auto px-4 py-3 text-[13px] leading-relaxed"
          onClick={() => inputRef.current?.focus()}
        >
          <p className="text-amber-dim">
            AI-TERM master console · {fleet.devices.length} devices, <span className="text-phos">{online.length} online</span>
          </p>
          <p className="text-amber-faint">
            The master agent can see the fleet, run tools on devices, and hand tasks to a device&apos;s own agent. Each device&apos;s
            own policy still decides.
          </p>

          {!ready && (
            <p className="border border-err/50 bg-err/5 px-3 py-2 text-xs text-err">
              !! {missingKey ?? "provider key"} is not set. Add it to the env, or pick another model in{" "}
              <Link href="/settings/llm" className="underline">
                settings / llm
              </Link>
              .
            </p>
          )}

          {messages.length === 0 && ready && (
            <div className="flex flex-wrap gap-2">
              {SUGGESTIONS.map((s, i) => (
                <motion.button
                  key={s}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.1 + i * 0.06 }}
                  onClick={() => submit(s)}
                  className="cursor-pointer border border-dashed border-line px-2 py-1 text-xs text-muted transition-colors hover:border-amber hover:text-amber"
                >
                  &gt; {s}
                </motion.button>
              ))}
            </div>
          )}

          {messages.map((m, i) => {
            const last = i === messages.length - 1;
            if (m.role === "user") {
              return (
                <motion.p key={m.id} initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="text-fg">
                  <span className="text-phos">admin@master</span>
                  <span className="text-muted">:~$ </span>
                  {textOf(m)}
                </motion.p>
              );
            }
            return (
              <motion.div key={m.id} initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-2">
                {m.parts.map((part, j) => {
                  if (part.type === "text") {
                    if (!part.text) return null;
                    const streaming = busy && last && j === m.parts.length - 1;
                    return (
                      <p key={j} className={cn("whitespace-pre-wrap border-l border-amber/30 pl-3 text-amber glow", streaming && "cursor")}>
                        {part.text}
                      </p>
                    );
                  }
                  if (part.type.startsWith("tool-")) {
                    const p = part as unknown as ToolPart;
                    // Device calls made by the master carry ids like "<toolCallId>:<device>".
                    const waiting = fleet.pending.some((c) => c.id.startsWith(`${p.toolCallId}:`));
                    return <MasterToolCard key={j} part={p} awaitingApproval={waiting} />;
                  }
                  return null;
                })}
              </motion.div>
            );
          })}

          {status === "submitted" && (
            <p className="border-l border-amber/30 pl-3 text-amber-dim">
              thinking<span className="animate-blink">_</span>
            </p>
          )}
          {error && <p className="text-xs text-err">!! {error.message}</p>}
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit(input);
          }}
          className="flex items-center gap-2 border-t border-line bg-bg-2/60 px-4 py-2.5"
        >
          <span className="shrink-0 text-xs">
            <span className="text-phos">admin@master</span>
            <span className="text-muted">:~$</span>
          </span>
          <input
            ref={inputRef}
            autoFocus
            value={input}
            disabled={!ready}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && busy) stop();
              if (e.key === "ArrowUp" && history.length) {
                e.preventDefault();
                const next = Math.min(history.length - 1, cursor + 1);
                setCursor(next);
                setInput(history[next]);
              }
              if (e.key === "ArrowDown") {
                e.preventDefault();
                const next = cursor - 1;
                setCursor(Math.max(-1, next));
                setInput(next < 0 ? "" : history[next]);
              }
            }}
            placeholder={ready ? "command the fleet… (click a device to @mention it)" : "no model available"}
            className="min-w-0 flex-1 bg-transparent text-[13px] text-amber outline-none placeholder:text-amber-faint"
          />
          {busy ? (
            <Button type="button" size="sm" variant="danger" onClick={() => stop()}>
              stop
            </Button>
          ) : (
            <Button type="submit" size="sm" variant="primary" disabled={!input.trim() || !ready}>
              send
            </Button>
          )}
        </form>
      </Panel>

      <div className="grid content-start gap-4">
        <Approvals pending={fleet.pending} devices={fleet.devices} />
        <FleetPanel devices={fleet.devices} onMention={mention} />
      </div>
    </div>
  );
}

// ── tool calls made by the master agent ─────────────────────────────────

type ToolPart = {
  type: string;
  toolCallId: string;
  state: "input-streaming" | "input-available" | "approval-requested" | "output-available" | "output-error" | string;
  input?: Record<string, unknown>;
  output?: unknown;
  errorText?: string;
};

function describe(name: string, input: Record<string, unknown> = {}) {
  switch (name) {
    case "list_devices":
      return { icon: "◉", title: "scan fleet", detail: "" };
    case "device_tools":
      return { icon: "◇", title: `tools on ${input.device ?? "…"}`, detail: "" };
    case "recent_activity":
      return { icon: "≡", title: `activity ${input.device ? `on ${input.device}` : "across the fleet"}`, detail: "" };
    case "call_device_tool": {
      const args = (input.args ?? {}) as Record<string, unknown>;
      const target = args.command ? `$ ${args.command}` : (args.path ?? args.root ?? "") as string;
      return { icon: "⚙", title: `${input.device ?? "…"} › ${input.tool ?? "…"}`, detail: String(target ?? "") };
    }
    case "ask_device":
      return { icon: "↪", title: `delegate to ${input.device ?? "…"}`, detail: String(input.prompt ?? "") };
    default:
      return { icon: "⚙", title: name, detail: "" };
  }
}

function outputText(output: unknown): string {
  if (typeof output === "string") return output;
  return JSON.stringify(output, null, 2);
}

function MasterToolCard({ part, awaitingApproval }: { part: ToolPart; awaitingApproval: boolean }) {
  const [open, setOpen] = useState(false);
  const name = part.type.slice("tool-".length);
  const d = describe(name, part.input);
  const done = part.state === "output-available";
  const failed = part.state === "output-error";
  const out = done ? outputText(part.output) : "";
  const denied = done && /DENIED/.test(out);
  const tone = failed || denied ? "text-err" : done ? "text-phos" : awaitingApproval ? "text-warn" : "text-amber";
  const state = failed
    ? "failed"
    : denied
      ? "denied"
      : done
        ? "done"
        : awaitingApproval
          ? "needs approval"
          : name === "ask_device"
            ? "device working"
            : "running";

  return (
    <motion.div
      initial={{ opacity: 0, x: -6 }}
      animate={{ opacity: 1, x: 0 }}
      className={cn("ml-3 border px-3 py-2 text-xs", done || failed ? "border-line bg-bg-2/50" : "border-amber/40 bg-amber/[0.04]")}
    >
      <button onClick={() => setOpen((o) => !o)} className="flex w-full cursor-pointer items-center gap-2 text-left">
        <span className={tone}>{d.icon}</span>
        <span className={cn("font-bold", tone)}>{d.title}</span>
        <span className="min-w-0 flex-1 truncate text-fg/70">{d.detail}</span>
        <span className={cn("shrink-0 text-[10px] uppercase tracking-[0.12em]", tone)}>
          {!done && !failed && <span className="mr-1 inline-block animate-spin">◌</span>}
          {state}
        </span>
        <span className="text-amber-faint">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="mt-2 space-y-2 border-t border-dashed border-line pt-2">
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap text-[11px] text-amber-dim">{JSON.stringify(part.input ?? {}, null, 2)}</pre>
          {(done || failed) && (
            <pre className={cn("max-h-72 overflow-auto whitespace-pre-wrap text-[11px]", failed ? "text-err" : "text-fg/80")}>
              {failed ? part.errorText : out}
            </pre>
          )}
        </div>
      )}
    </motion.div>
  );
}

// ── side panels ─────────────────────────────────────────────────────────

function Approvals({ pending, devices }: { pending: ToolCallRow[]; devices: FleetDevice[] }) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);

  async function decide(call: ToolCallRow, approved: boolean) {
    setBusy(call.id);
    const res = await fetch(`/api/devices/${call.device_id}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ call_id: call.id, approved }),
    });
    if (!res.ok) toast((await res.json().catch(() => ({}))).error ?? "failed", "err");
    setBusy(null);
  }

  return (
    <Panel title={`approvals // ${pending.length}`}>
      {pending.length === 0 ? (
        <p className="text-xs text-muted">Nothing waiting. Calls that need a human show up here, from every device.</p>
      ) : (
        <ul className="space-y-2">
          <AnimatePresence initial={false}>
            {pending.map((call) => {
              const device = devices.find((d) => d.id === call.device_id);
              const remote = device?.access?.remote_approval;
              const a = call.args as Record<string, unknown>;
              const target = a.command ? `$ ${a.command}` : String(a.path ?? a.root ?? a.source ?? "");
              return (
                <motion.li
                  key={call.id}
                  layout
                  initial={{ opacity: 0, scale: 0.97 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, height: 0 }}
                  className="animate-pulse border border-warn/60 bg-warn/[0.06] p-2 text-xs [animation-duration:2.4s]"
                >
                  <p className="flex items-center justify-between gap-2">
                    <span className="truncate font-bold text-warn">
                      {device?.name ?? "device"} › {call.name}
                    </span>
                    {call.risk && <Tag tone="warn">{call.risk}</Tag>}
                  </p>
                  {target && <p className="mt-0.5 truncate text-fg/80" title={target}>{target}</p>}
                  <p className="mt-0.5 text-[11px] text-muted">{call.reason}</p>
                  {remote ? (
                    <div className="mt-2 flex gap-2">
                      <Button size="sm" variant="phos" disabled={busy === call.id} onClick={() => decide(call, true)}>
                        approve
                      </Button>
                      <Button size="sm" variant="danger" disabled={busy === call.id} onClick={() => decide(call, false)}>
                        deny
                      </Button>
                    </div>
                  ) : (
                    <p className="mt-1 text-[11px] text-amber-faint">approve on the device itself</p>
                  )}
                </motion.li>
              );
            })}
          </AnimatePresence>
        </ul>
      )}
    </Panel>
  );
}

function FleetPanel({ devices, onMention }: { devices: FleetDevice[]; onMention: (name: string) => void }) {
  const sorted = [...devices].sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
  return (
    <Panel title={`fleet // ${devices.filter((d) => d.online).length}/${devices.length}`}>
      {sorted.length === 0 ? (
        <p className="text-xs text-muted">No devices registered yet.</p>
      ) : (
        <ul className="space-y-1">
          {sorted.map((d) => (
            <li key={d.id} className="group flex items-center gap-2 text-xs">
              <Led on={d.online} />
              <DeviceKindIcon kind={d.kind} className={d.online ? "text-phos" : "text-amber-faint"} />
              <button
                onClick={() => onMention(d.name)}
                title="mention in the prompt"
                className={cn("min-w-0 flex-1 cursor-pointer truncate text-left hover:text-amber", d.online ? "text-fg" : "text-muted")}
              >
                {d.name}
              </button>
              {d.busy && <span className="text-[10px] uppercase text-phos">working</span>}
              {d.access && (
                <Tag tone={LEVEL_TONE[d.access.level] ?? "muted"} className={cn(d.access.level === "yolo" && "animate-pulse")}>
                  {d.access.level}
                </Tag>
              )}
              {d.online && !d.access && <Tag tone="muted">chat</Tag>}
              <Link href={`/devices/${d.id}`} className="text-amber-faint opacity-0 transition-opacity group-hover:opacity-100 hover:text-amber">
                →
              </Link>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-[11px] text-amber-faint">Tools: {Array.from(new Set(devices.flatMap((d) => d.tools))).length} kinds across the fleet.</p>
    </Panel>
  );
}
