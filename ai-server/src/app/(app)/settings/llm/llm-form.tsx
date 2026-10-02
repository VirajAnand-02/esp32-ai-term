"use client";

import { motion } from "motion/react";
import { useRef, useState, useTransition } from "react";
import { saveLlm } from "@/app/actions/settings";
import { AsciiBar } from "@/components/term/motion";
import { Button, Input, Label, Led, NotWired, Panel, Select, Textarea } from "@/components/term/primitives";
import { useToast } from "@/components/term/toast";
import { cn } from "@/lib/cn";
import type { LlmSettings } from "@/lib/types";

type Provider = { id: string; label: string; envKey: string; models: string[]; configured: boolean };

export function LlmForm({ initial, providers, defaultPrompt }: { initial: LlmSettings; providers: Provider[]; defaultPrompt: string }) {
  const [s, setS] = useState(initial);
  const [saved, setSaved] = useState(initial);
  const [pending, start] = useTransition();
  const toast = useToast();

  const [providerId, modelId] = splitModel(s.model);
  const provider = providers.find((p) => p.id === providerId);
  const custom = provider ? !provider.models.includes(modelId) : true;
  const dirty = JSON.stringify(s) !== JSON.stringify(saved);

  function save() {
    start(async () => {
      const res = await saveLlm(s);
      if (res.ok) {
        setSaved(s);
        toast(`model set to ${s.model}`);
      } else toast(res.error, "err");
    });
  }

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_400px]">
      <div className="grid content-start gap-4">
        <Panel title="provider">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {providers.map((p) => {
              const active = p.id === providerId;
              return (
                <motion.button
                  key={p.id}
                  whileTap={{ scale: 0.98 }}
                  onClick={() => setS({ ...s, model: `${p.id}:${active ? modelId : p.models[0]}` })}
                  className={cn(
                    "relative cursor-pointer border p-3 text-left transition-all",
                    active ? "border-amber bg-amber/[0.06] shadow-[0_0_20px_rgb(255_176_0/0.1)]" : "border-line hover:border-line-2",
                  )}
                >
                  {active && <motion.span layoutId="provider-active" className="absolute inset-x-0 top-0 h-0.5 bg-amber shadow-[0_0_8px_var(--amber)]" />}
                  <span className="flex items-center justify-between">
                    <span className={cn("text-sm", active ? "text-amber glow" : "text-fg")}>{p.label}</span>
                    <Led on={p.configured} tone={p.configured ? "phos" : "err"} />
                  </span>
                  <span className={cn("mt-1 block text-[10px]", p.configured ? "text-muted" : "text-err")}>
                    {p.configured ? "key loaded" : `${p.envKey} missing`}
                  </span>
                </motion.button>
              );
            })}
          </div>
        </Panel>

        <Panel
          title="model"
          actions={
            <>
              {dirty && <span className="text-[10px] uppercase tracking-[0.14em] text-warn">unsaved *</span>}
              <Button size="sm" variant="primary" onClick={save} disabled={!dirty || pending}>
                {pending ? "saving…" : "save"}
              </Button>
            </>
          }
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block">
              <Label hint={provider?.label}>model</Label>
              <Select
                value={custom ? "__custom" : modelId}
                onChange={(e) => setS({ ...s, model: `${providerId}:${e.target.value === "__custom" ? "" : e.target.value}` })}
              >
                {provider?.models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
                <option value="__custom">custom…</option>
              </Select>
            </label>
            <label className="block">
              <Label hint="provider:model">resolved id</Label>
              <Input value={s.model} onChange={(e) => setS({ ...s, model: e.target.value.trim() })} spellCheck={false} />
            </label>

            <div>
              <Label hint={s.temperature == null ? "provider default" : s.temperature.toFixed(2)}>temperature</Label>
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min={0}
                  max={2}
                  step={0.05}
                  value={s.temperature ?? 1}
                  disabled={s.temperature == null}
                  onChange={(e) => setS({ ...s, temperature: Number(e.target.value) })}
                  className="h-1 flex-1 cursor-pointer accent-[var(--amber)] disabled:opacity-30"
                />
                <label className="flex cursor-pointer items-center gap-1 text-[11px] text-muted">
                  <input
                    type="checkbox"
                    checked={s.temperature == null}
                    onChange={(e) => setS({ ...s, temperature: e.target.checked ? null : 0.7 })}
                    className="accent-[var(--amber)]"
                  />
                  default
                </label>
              </div>
              <AsciiBar key={s.temperature ?? "d"} value={(s.temperature ?? 0) / 2} width={30} className="mt-1 block text-[11px]" />
            </div>

            <label className="block">
              <Label hint="per reply">max output tokens</Label>
              <Input
                type="number"
                min={16}
                max={32768}
                value={s.maxOutputTokens}
                onChange={(e) => setS({ ...s, maxOutputTokens: Number(e.target.value) || 16 })}
              />
            </label>
          </div>
        </Panel>

        <Panel
          title="system prompt"
          actions={
            <button onClick={() => setS({ ...s, systemPrompt: defaultPrompt })} className="cursor-pointer text-[11px] text-muted hover:text-amber">
              reset
            </button>
          }
        >
          <Textarea value={s.systemPrompt} onChange={(e) => setS({ ...s, systemPrompt: e.target.value })} className="min-h-40 text-xs" />
          <p className="mt-1 text-right text-[10px] text-amber-faint">{s.systemPrompt.length}/8000</p>
        </Panel>

        <Panel title="pipeline" actions={<NotWired />}>
          <div className="grid gap-4 opacity-60 sm:grid-cols-3">
            {[
              ["fallback model", "none"],
              ["speech → text", "whisper-1"],
              ["text → speech", "alloy"],
            ].map(([label, value]) => (
              <label key={label} className="block">
                <Label>{label}</Label>
                <Select disabled defaultValue={value}>
                  <option>{value}</option>
                </Select>
              </label>
            ))}
          </div>
        </Panel>
      </div>

      <TestBench settings={s} ready={Boolean(provider?.configured)} />
    </div>
  );
}

function splitModel(id: string): [string, string] {
  const i = id.indexOf(":");
  return i < 0 ? [id, ""] : [id.slice(0, i), id.slice(i + 1)];
}

function TestBench({ settings, ready }: { settings: LlmSettings; ready: boolean }) {
  const [prompt, setPrompt] = useState("Say hello to the terminal in one short line.");
  const [out, setOut] = useState("");
  const [err, setErr] = useState<string>();
  const [running, setRunning] = useState(false);
  const [timing, setTiming] = useState<{ first?: number; total?: number }>({});
  const ctrl = useRef<AbortController | null>(null);

  async function run() {
    ctrl.current?.abort();
    const c = new AbortController();
    ctrl.current = c;
    setOut("");
    setErr(undefined);
    setTiming({});
    setRunning(true);
    const t0 = performance.now();
    try {
      const res = await fetch("/api/llm/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...settings, prompt }),
        signal: c.signal,
      });
      if (!res.ok || !res.body) throw new Error(await res.text());
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let first = true;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (first) {
          setTiming({ first: Math.round(performance.now() - t0) });
          first = false;
        }
        setOut((o) => o + dec.decode(value, { stream: true }));
      }
      setTiming((t) => ({ ...t, total: Math.round(performance.now() - t0) }));
    } catch (e) {
      if ((e as Error).name !== "AbortError") setErr((e as Error).message || "request failed");
    } finally {
      setRunning(false);
    }
  }

  return (
    <Panel title="test bench" className="self-start xl:sticky xl:top-16">
      <p className="mb-3 text-[11px] text-muted">Runs with the settings on the left, saved or not.</p>
      <Textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} className="min-h-20 text-xs" />
      <div className="mt-2 flex items-center justify-between">
        <span className="text-[10px] text-amber-faint">
          {timing.first != null && <>ttft {timing.first}ms</>}
          {timing.total != null && <> · total {timing.total}ms</>}
        </span>
        {running ? (
          <Button size="sm" variant="danger" onClick={() => ctrl.current?.abort()}>
            abort
          </Button>
        ) : (
          <Button size="sm" variant="phos" onClick={run} disabled={!ready || !prompt.trim()}>
            run
          </Button>
        )}
      </div>
      <div className="mt-3 min-h-32 border border-dashed border-line bg-bg-2/60 p-3 text-xs leading-relaxed">
        {!ready && <p className="text-err">!! provider key missing</p>}
        {err && <p className="whitespace-pre-wrap text-err">!! {err}</p>}
        {!err && (out || running) && <p className={cn("whitespace-pre-wrap text-amber glow", running && "cursor")}>{out}</p>}
        {!err && !out && !running && ready && <p className="text-amber-faint">output appears here_</p>}
      </div>
    </Panel>
  );
}
