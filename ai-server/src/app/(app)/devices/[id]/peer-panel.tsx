"use client";

import { useState, useTransition } from "react";
import { removePeerConfig, savePeerConfig, testPeer } from "@/app/actions/peers";
import { Button, Input, Label, Led, Panel, Select } from "@/components/term/primitives";
import { useToast } from "@/components/term/toast";
import type { Reachable } from "@/lib/peers";

// What the server is willing to say about a configured peer. The key is never part of
// it: it is sent to the harness, so it cannot be hashed, which makes "never leaves the
// server" the only protection it has.
export type PeerView = { baseUrl: string; model: string; timeoutS: number; hasKey: boolean; reach: Reachable } | null;

const TIMEOUTS = [120, 300, 900, 1800, 3600];

export function PeerPanel({ deviceId, deviceName, peer }: { deviceId: string; deviceName: string; peer: PeerView }) {
  const [baseUrl, setBaseUrl] = useState(peer?.baseUrl ?? "");
  const [model, setModel] = useState(peer?.model ?? "");
  const [apiKey, setApiKey] = useState("");
  const [timeoutS, setTimeoutS] = useState(peer?.timeoutS ?? 900);
  const [result, setResult] = useState("");
  const [pending, start] = useTransition();
  const toast = useToast();

  function save() {
    start(async () => {
      const res = await savePeerConfig(deviceId, { baseUrl: baseUrl.trim(), apiKey: apiKey.trim(), model: model.trim(), timeoutS });
      if (!res.ok) return toast(res.error, "err");
      setApiKey("");
      setResult("");
      toast("endpoint saved");
    });
  }

  function check() {
    start(async () => {
      const res = await testPeer(deviceId);
      setResult(res.ok ? res.detail : res.error);
      toast(res.ok ? "it answered" : res.error, res.ok ? "ok" : "err");
    });
  }

  function remove() {
    start(async () => {
      const res = await removePeerConfig(deviceId);
      if (!res.ok) return toast(res.error, "err");
      setBaseUrl("");
      setModel("");
      setApiKey("");
      setResult("");
      toast("endpoint removed");
    });
  }

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_400px]">
      <Panel title="agent endpoint">
        <div className="grid gap-3">
          <span className="flex items-center gap-2 text-xs">
            <Led on={Boolean(peer)} tone={peer ? "phos" : "err"} />
            <span className={peer ? "text-muted" : "text-err"}>
              {peer ? `${peer.baseUrl}${peer.hasKey ? " · key set" : " · no key"}` : "no endpoint set; this agent cannot be asked anything yet"}
            </span>
          </span>

          <label className="block">
            <Label hint="where the harness listens — OpenClaw 18789, Hermes 8642">base url</Label>
            <Input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://box.tailnet.ts.net:18789"
              autoComplete="off"
              spellCheck={false}
            />
          </label>

          <label className="block">
            <Label hint={peer?.hasKey ? "leave blank to keep the key that is saved" : "the harness's bearer token"}>api key</Label>
            <Input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={peer?.hasKey ? "unchanged" : "sk-… / API_SERVER_KEY"}
              autoComplete="new-password"
            />
          </label>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <Label hint="optional; most harnesses ignore it">model</Label>
              <Input value={model} onChange={(e) => setModel(e.target.value)} placeholder="default" autoComplete="off" spellCheck={false} />
            </label>
            <label className="block">
              <Label hint="how long before the task is abandoned">give up after</Label>
              <Select value={String(timeoutS)} onChange={(e) => setTimeoutS(Number(e.target.value))}>
                {TIMEOUTS.map((s) => (
                  <option key={s} value={s}>
                    {s < 3600 ? `${s / 60} min` : "1 hour"}
                  </option>
                ))}
              </Select>
            </label>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button variant="primary" onClick={save} disabled={pending || !baseUrl.trim()}>
              save
            </Button>
            <Button onClick={check} disabled={pending || !peer}>
              test it
            </Button>
            {peer && (
              <Button variant="ghost" onClick={remove} disabled={pending}>
                remove
              </Button>
            )}
          </div>

          {result && <p className="border border-line p-2 text-xs text-muted">{result}</p>}
        </div>
      </Panel>

      <Panel title="how this works">
        <div className="space-y-3 text-xs opacity-70">
          <p>
            <span className="text-[var(--amber)]">{deviceName}</span> is an attached harness — OpenClaw, NanoClaw,
            Hermes — not a machine that connects here. The server calls its{" "}
            <span className="text-[var(--amber)]">/v1/chat/completions</span>, which all three of them speak, so
            there is nothing to install on their side for the outbound direction.
          </p>
          <p>
            Any agent on the fleet reaches it with{" "}
            <span className="text-[var(--amber)]">ask_device(&quot;{deviceName}&quot;, …)</span>. An answer inside a
            minute comes straight back; a slower one is handed off, and arrives as a notification on the terminal
            with the full text behind <span className="text-[var(--amber)]">agent_job</span>. One task at a time.
          </p>
          <p>
            Each request is self-contained: the endpoint is stateless and we send only the task, so the harness
            starts fresh and its own memory does the remembering.
          </p>
          <Label hint="the other direction: give the harness this and it can speak first">talking back</Label>
          <pre className="overflow-x-auto border border-line p-2 text-[10px] leading-relaxed">
            {`curl -XPOST "$SERVER/api/peers/inbox" \\\n  -H "Authorization: Bearer <its device token>" \\\n  -H "content-type: application/json" \\\n  -d '{"text":"the deploy finished"}'`}
          </pre>
          <p className="text-[11px]">
            That lands as a notification on the terminal. The token is this device&apos;s own, shown when it was
            registered — only its hash is stored here, so rotate it in Settings → devices if it has been lost.
          </p>
          <p className="text-[11px] text-amber-faint">
            The key is sent to the harness, so it cannot be hashed — it is never returned to this page once saved.
            A harness runs real code on its own machine; nothing here gives it access to this fleet.
          </p>
        </div>
      </Panel>
    </div>
  );
}
