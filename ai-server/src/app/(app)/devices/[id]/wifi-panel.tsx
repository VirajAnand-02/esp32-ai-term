"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { Button, EmptyState, Input, Label, Led, Panel } from "@/components/term/primitives";
import { useToast } from "@/components/term/toast";

type Saved = { ssids: string[]; current: string };

// The networks a device has saved.
//
// Credentials only ever travel downward. What comes back is a list of names and
// which one is joined, so this panel cannot show a password and there is nothing
// here to leak. Adding one while the device is already connected does not move it:
// the firmware stays on the link it has until that link drops, which is deliberate.
export function WifiPanel({ deviceId, online }: { deviceId: string; online: boolean }) {
  const [saved, setSaved] = useState<Saved | null>(null);
  const [ssid, setSsid] = useState("");
  const [password, setPassword] = useState("");
  const [pending, start] = useTransition();
  const toast = useToast();

  // Returns rather than setting, so the caller decides whether the answer is still
  // wanted — this panel can be unmounted by a tab change while a fetch is in flight.
  const fetchSaved = useCallback(async (): Promise<Saved | null> => {
    try {
      const res = await fetch(`/api/devices/${deviceId}/live`, { cache: "no-store" });
      const data = await res.json();
      return (data.wifi as Saved | null) ?? null;
    } catch {
      return null;
    }
  }, [deviceId]);

  useEffect(() => {
    if (!online) return;
    let alive = true;
    void (async () => {
      const next = await fetchSaved();
      if (alive) setSaved(next);
    })();
    return () => {
      alive = false;
    };
  }, [online, fetchSaved]);

  function send(payload: Record<string, unknown>, done: string) {
    start(async () => {
      const res = await fetch(`/api/devices/${deviceId}/wifi`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return toast(data.error ?? "that did not work", "err");
      toast(done);
      setSsid("");
      setPassword("");
      // The device writes to NVS and reports the new list back, which takes a moment.
      await new Promise((r) => setTimeout(r, 600));
      setSaved(await fetchSaved());
    });
  }

  if (!online) {
    return (
      <Panel title="wi-fi">
        <EmptyState title="device is offline">
          The saved networks live on the device, so they can only be read while it is connected.
        </EmptyState>
      </Panel>
    );
  }

  return (
    <Panel title="wi-fi">
      <div className="grid gap-4">
        <div className="grid gap-1">
          {saved?.ssids.length ? (
            saved.ssids.map((s) => (
              <span key={s} className="flex items-center justify-between border border-line px-2 py-1 text-xs">
                <span className="flex items-center gap-2">
                  <Led on={s === saved.current} tone="phos" />
                  <span className={s === saved.current ? "text-amber" : "text-fg"}>{s}</span>
                </span>
                <Button size="sm" variant="ghost" disabled={pending} onClick={() => send({ action: "forget", ssid: s }, `forgot ${s}`)}>
                  forget
                </Button>
              </span>
            ))
          ) : (
            <p className="text-xs text-muted">nothing saved yet</p>
          )}
        </div>

        <div className="grid gap-2 border-t border-line pt-3">
          <Label hint="2.4 GHz only — the S3 has no 5 GHz radio">add a network</Label>
          <Input value={ssid} onChange={(e) => setSsid(e.target.value)} placeholder="network name" autoComplete="off" />
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="password, or blank if open"
            autoComplete="new-password"
          />
          <Button
            variant="primary"
            disabled={pending || !ssid.trim()}
            onClick={() => send({ action: "add", ssid: ssid.trim(), password }, `sent ${ssid.trim()} to the device`)}
          >
            send to the device
          </Button>
          <p className="text-[11px] text-amber-faint">
            Stored on the device, in its own NVS namespace. It will be used the next time the current link drops —
            adding one does not make it jump networks.
          </p>
        </div>
      </div>
    </Panel>
  );
}
