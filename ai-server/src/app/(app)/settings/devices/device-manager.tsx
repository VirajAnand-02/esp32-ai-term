"use client";

import { AnimatePresence, motion } from "motion/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { addDevice, removeDevice, renameDevice, rotateToken } from "@/app/actions/devices";
import { DeviceKindIcon } from "@/components/term/device-kind";
import { TimeAgo } from "@/components/term/motion";
import { Button, EmptyState, Input, Label, Led, Panel } from "@/components/term/primitives";
import { useToast } from "@/components/term/toast";
import { cn } from "@/lib/cn";
import { DEVICE_KINDS, type Device, type DeviceKind } from "@/lib/types";

type Reveal = { name: string; token: string; rotated?: boolean };

export function DeviceManager({ devices, wsUrl }: { devices: Device[]; wsUrl: string }) {
  const [reveal, setReveal] = useState<Reveal | null>(null);
  const router = useRouter();

  return (
    <div className="grid gap-4 xl:grid-cols-[360px_minmax(0,1fr)]">
      <AddDevice
        onAdded={(r) => {
          setReveal(r);
          router.refresh();
        }}
      />
      <Panel title={`registered // ${devices.length}`} bodyClassName="p-0">
        {devices.length === 0 ? (
          <EmptyState title="no devices">Register one on the left.</EmptyState>
        ) : (
          <ul className="divide-y divide-dashed divide-line">
            <AnimatePresence initial={false}>
              {devices.map((d) => (
                <DeviceRow key={d.id} device={d} onReveal={setReveal} />
              ))}
            </AnimatePresence>
          </ul>
        )}
      </Panel>
      <TokenModal reveal={reveal} wsUrl={wsUrl} onClose={() => setReveal(null)} />
    </div>
  );
}

function AddDevice({ onAdded }: { onAdded: (r: Reveal) => void }) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<DeviceKind>("esp32");
  const [hostname, setHostname] = useState("");
  const [pending, start] = useTransition();
  const toast = useToast();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    start(async () => {
      const res = await addDevice({ name, kind, hostname });
      if (!res.ok) return toast(res.error, "err");
      toast(`${name} registered`);
      onAdded({ name, token: res.token });
      setName("");
      setHostname("");
    });
  }

  return (
    <Panel title="register device" className="self-start">
      <form onSubmit={submit} className="space-y-3">
        <label className="block">
          <Label>name</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="desk-terminal" required maxLength={48} />
        </label>
        <div>
          <Label>kind</Label>
          <div className="grid grid-cols-4 gap-1">
            {DEVICE_KINDS.map((k) => (
              <button
                type="button"
                key={k}
                onClick={() => setKind(k)}
                className={cn(
                  "flex cursor-pointer flex-col items-center gap-1 border py-2 text-[10px] uppercase transition-all",
                  kind === k ? "border-amber bg-amber/10 text-amber" : "border-line text-muted hover:text-fg",
                )}
              >
                <DeviceKindIcon kind={k} />
                {k}
              </button>
            ))}
          </div>
        </div>
        <label className="block">
          <Label hint="optional">mdns hostname</Label>
          <Input value={hostname} onChange={(e) => setHostname(e.target.value)} placeholder="ai-term" maxLength={64} />
        </label>
        <Button variant="primary" className="w-full" disabled={pending || !name.trim()}>
          {pending ? "generating token…" : "register + issue token"}
        </Button>
        <p className="text-[11px] text-amber-faint">The token is shown once. Only its sha256 hash is stored.</p>
      </form>
    </Panel>
  );
}

function DeviceRow({ device, onReveal }: { device: Device; onReveal: (r: Reveal) => void }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(device.name);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const toast = useToast();
  const router = useRouter();

  function rename() {
    start(async () => {
      const res = await renameDevice(device.id, name);
      if (!res.ok) return toast(res.error, "err");
      setEditing(false);
      toast(`renamed to ${name}`);
      router.refresh();
    });
  }

  function rotate() {
    start(async () => {
      const res = await rotateToken(device.id);
      if (!res.ok) return toast(res.error, "err");
      onReveal({ name: device.name, token: res.token, rotated: true });
    });
  }

  function remove() {
    start(async () => {
      const res = await removeDevice(device.id);
      if (!res.ok) return toast(res.error, "err");
      toast(`${device.name} removed`, "info");
      router.refresh();
    });
  }

  // This list is for renaming, rotating and removing, so it does not load reachability.
  // An attached agent therefore gets a neutral dot rather than `status`, which is
  // permanently "offline" for one and would read as a fault. See lib/fleet-view.ts.
  const isAgent = device.kind === "agent";

  return (
    <motion.li layout exit={{ opacity: 0, height: 0, filter: "brightness(3)" }} className="px-3 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <Led
          on={!isAgent && device.status === "online"}
          tone={isAgent ? "amber" : undefined}
          label={isAgent ? "attached agent" : undefined}
        />
        <DeviceKindIcon kind={device.kind} className="text-amber-dim" />
        <div className="min-w-0 flex-1">
          {editing ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                rename();
              }}
              className="flex gap-2"
            >
              <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} className="h-7 max-w-60 text-xs" />
              <Button size="sm" variant="primary" disabled={pending}>
                ok
              </Button>
              <Button size="sm" type="button" onClick={() => (setEditing(false), setName(device.name))}>
                esc
              </Button>
            </form>
          ) : (
            <>
              <Link href={`/devices/${device.id}`} className="text-sm text-fg hover:text-amber">
                {device.name}
              </Link>
              <p className="text-[10px] text-muted">
                {device.kind}
                {device.hostname && ` · ${device.hostname}.local`} · seen <TimeAgo iso={device.last_seen_at} />
              </p>
            </>
          )}
        </div>
        {!editing && confirm === null && (
          <div className="flex gap-1.5">
            <Button size="sm" onClick={() => setEditing(true)}>
              rename
            </Button>
            <Button size="sm" onClick={rotate} disabled={pending || device.kind === "web"} title="Issue a new token; the old one stops working">
              rotate
            </Button>
            <Button size="sm" variant="danger" onClick={() => setConfirm("")}>
              rm
            </Button>
          </div>
        )}
      </div>
      <AnimatePresence>
        {confirm !== null && (
          <motion.form
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            onSubmit={(e) => {
              e.preventDefault();
              if (confirm === device.name) remove();
            }}
            className="mt-3 overflow-hidden border border-err/50 bg-err/5 p-3"
          >
            <p className="mb-2 text-xs text-err">
              !! this deletes {device.name} and all its logs and sessions. type <span className="font-bold">{device.name}</span> to confirm:
            </p>
            <div className="flex gap-2">
              <Input autoFocus value={confirm} onChange={(e) => setConfirm(e.target.value)} className="h-7 text-xs focus:border-err" />
              <Button size="sm" variant="danger" disabled={confirm !== device.name || pending}>
                delete
              </Button>
              <Button size="sm" type="button" onClick={() => setConfirm(null)}>
                cancel
              </Button>
            </div>
          </motion.form>
        )}
      </AnimatePresence>
    </motion.li>
  );
}

function TokenModal({ reveal, wsUrl, onClose }: { reveal: Reveal | null; wsUrl: string; onClose: () => void }) {
  const [copied, setCopied] = useState<string | null>(null);

  async function copy(label: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const t = document.createElement("textarea");
      t.value = text;
      document.body.appendChild(t);
      t.select();
      document.execCommand("copy");
      t.remove();
    }
    setCopied(label);
    setTimeout(() => setCopied(null), 1400);
  }

  return (
    <AnimatePresence>
      {reveal && (
        <motion.div className="fixed inset-0 z-[80] grid place-items-center bg-bg/80 px-4 backdrop-blur-sm" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          <motion.div
            role="dialog"
            aria-label="Device token"
            initial={{ scaleY: 0.02, opacity: 0 }}
            animate={{ scaleY: 1, opacity: 1 }}
            exit={{ scaleY: 0.02, opacity: 0 }}
            className="w-full max-w-xl border border-phos/60 bg-panel p-5 shadow-[0_0_50px_rgb(57_255_122/0.12)]"
          >
            <p className="text-[10px] uppercase tracking-[0.2em] text-phos glow-phos">{reveal.rotated ? "token rotated" : "device registered"}</p>
            <h3 className="mt-1 font-display text-3xl text-amber glow">{reveal.name}</h3>
            <p className="mt-2 text-xs text-warn">Copy this now. It won&apos;t be shown again.</p>

            <CopyField label="token" value={reveal.token} copied={copied === "token"} onCopy={() => copy("token", reveal.token)} />
            <CopyField label="endpoint" value={wsUrl} copied={copied === "url"} onCopy={() => copy("url", wsUrl)} />

            <p className="mb-1 mt-4 text-[11px] text-muted">try it with the simulator:</p>
            <CopyField
              label="$"
              value={`pnpm fake-device ${reveal.token} ${wsUrl}`}
              copied={copied === "cmd"}
              onCopy={() => copy("cmd", `pnpm fake-device ${reveal.token} ${wsUrl}`)}
            />

            <div className="mt-5 flex justify-end">
              <Button variant="primary" onClick={onClose}>
                done
              </Button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function CopyField({ label, value, copied, onCopy }: { label: string; value: string; copied: boolean; onCopy: () => void }) {
  return (
    <div className="mt-3 flex items-stretch border border-line">
      <span className="grid w-20 shrink-0 place-items-center border-r border-line text-[10px] uppercase tracking-[0.14em] text-amber-dim">{label}</span>
      <code className="min-w-0 flex-1 truncate px-2 py-2 text-xs text-phos" title={value}>
        {value}
      </code>
      <button onClick={onCopy} className="relative w-20 shrink-0 cursor-pointer overflow-hidden border-l border-line text-[10px] uppercase tracking-[0.14em] text-amber transition-colors hover:bg-amber hover:text-bg">
        <AnimatePresence mode="wait" initial={false}>
          <motion.span key={copied ? "y" : "n"} initial={{ y: 12, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: -12, opacity: 0 }} className="block">
            {copied ? "✓ copied" : "copy"}
          </motion.span>
        </AnimatePresence>
      </button>
    </div>
  );
}
