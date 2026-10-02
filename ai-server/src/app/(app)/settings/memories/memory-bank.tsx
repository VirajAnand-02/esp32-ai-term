"use client";

import { AnimatePresence, motion } from "motion/react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { addMemory, removeMemory, toggleMemory } from "@/app/actions/settings";
import { LocalTime } from "@/components/term/motion";
import { Button, EmptyState, Input, Label, Panel, Select, Tag, Textarea } from "@/components/term/primitives";
import { useToast } from "@/components/term/toast";
import { cn } from "@/lib/cn";
import type { Memory } from "@/lib/types";

export function MemoryBank({ memories, devices }: { memories: Memory[]; devices: { id: string; name: string }[] }) {
  const [q, setQ] = useState("");
  const deviceName = (id: string | null) => (id ? (devices.find((d) => d.id === id)?.name ?? "unknown") : "global");
  const shown = memories.filter(
    (m) => !q || m.content.toLowerCase().includes(q.toLowerCase()) || m.tags.some((t) => t.includes(q.toLowerCase())),
  );

  return (
    <div className="grid gap-4 xl:grid-cols-[360px_minmax(0,1fr)]">
      <div className="grid content-start gap-4">
        <AddMemory devices={devices} />
        <Panel title="recall">
          <div className="space-y-3 text-xs opacity-70">
            <p>
              Every memory below that is <span className="text-[var(--amber)]">on</span> goes into the system prompt,
              rebuilt on each turn — so an edit here takes effect on the next answer, with no need to start a new
              session.
            </p>
            <p>
              <span className="text-[var(--amber)]">global</span> memories are read everywhere, including this console.
              A memory scoped to a device is read only when that device is the one talking.
            </p>
            <p>
              The agent keeps its own: <span className="text-[var(--amber)]">remember</span> and{" "}
              <span className="text-[var(--amber)]">forget</span> are tools it can call, and anything it saves shows up
              here to edit or delete.
            </p>
            <p className="text-[11px] text-amber-faint">
              The newest 40 of each scope are sent. Ranking the rest by relevance rather than by age needs pgvector
              (see databases).
            </p>
          </div>
        </Panel>
      </div>

      <Panel
        title={`memory bank // ${memories.length}`}
        actions={<Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="grep…" className="h-7 w-40 text-xs" />}
      >
        {shown.length === 0 ? (
          <EmptyState title={q ? "no matches" : "memory is empty"}>Facts the assistant should know about you, your home or a device.</EmptyState>
        ) : (
          <ul className="grid gap-2 md:grid-cols-2">
            <AnimatePresence initial={false}>
              {shown.map((m, i) => (
                <MemoryCard key={m.id} memory={m} scope={deviceName(m.device_id)} index={i} />
              ))}
            </AnimatePresence>
          </ul>
        )}
      </Panel>
    </div>
  );
}

function AddMemory({ devices }: { devices: { id: string; name: string }[] }) {
  const [content, setContent] = useState("");
  const [tags, setTags] = useState("");
  const [device, setDevice] = useState("");
  const [pending, start] = useTransition();
  const toast = useToast();
  const router = useRouter();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    start(async () => {
      const res = await addMemory({
        content,
        tags: tags.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean),
        device_id: device || null,
      });
      if (!res.ok) return toast(res.error, "err");
      toast("memory stored");
      setContent("");
      setTags("");
      router.refresh();
    });
  }

  return (
    <Panel title="new memory">
      <form onSubmit={submit} className="space-y-3">
        <label className="block">
          <Label hint={`${content.length}/2000`}>fact</Label>
          <Textarea value={content} onChange={(e) => setContent(e.target.value)} placeholder="The kitchen node is next to the coffee machine." className="min-h-20 text-xs" />
        </label>
        <label className="block">
          <Label hint="comma separated">tags</Label>
          <Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="home, kitchen" />
        </label>
        <label className="block">
          <Label>scope</Label>
          <Select value={device} onChange={(e) => setDevice(e.target.value)}>
            <option value="">global</option>
            {devices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </Select>
        </label>
        <Button variant="primary" className="w-full" disabled={pending || !content.trim()}>
          {pending ? "writing…" : "store"}
        </Button>
      </form>
    </Panel>
  );
}

function MemoryCard({ memory, scope, index }: { memory: Memory; scope: string; index: number }) {
  const [enabled, setEnabled] = useState(memory.enabled);
  const [pending, start] = useTransition();
  const toast = useToast();
  const router = useRouter();

  return (
    <motion.li
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0, transition: { delay: Math.min(index, 10) * 0.03 } }}
      exit={{ opacity: 0, scale: 0.96, filter: "brightness(3)" }}
      className={cn("group border p-3 transition-colors", enabled ? "border-line hover:border-line-2" : "border-dashed border-line opacity-50")}
    >
      <p className="whitespace-pre-wrap text-xs text-fg">{memory.content}</p>
      <div className="mt-2 flex flex-wrap items-center gap-1">
        <Tag tone={memory.device_id ? "info" : "phos"}>{scope}</Tag>
        {memory.tags.map((t) => (
          <Tag key={t} tone="muted">
            #{t}
          </Tag>
        ))}
      </div>
      <div className="mt-2 flex items-center justify-between text-[10px] text-amber-faint">
        <LocalTime iso={memory.created_at} withDate />
        <span className="flex gap-3 opacity-60 transition-opacity group-hover:opacity-100">
          <button
            disabled={pending}
            onClick={() =>
              start(async () => {
                const next = !enabled;
                setEnabled(next);
                const res = await toggleMemory(memory.id, next);
                if (!res.ok) {
                  setEnabled(!next);
                  toast(res.error, "err");
                }
              })
            }
            className="cursor-pointer uppercase hover:text-amber"
          >
            {enabled ? "disable" : "enable"}
          </button>
          <button
            disabled={pending}
            onClick={() =>
              start(async () => {
                const res = await removeMemory(memory.id);
                if (!res.ok) return toast(res.error, "err");
                router.refresh();
              })
            }
            className="cursor-pointer uppercase hover:text-err"
          >
            forget
          </button>
        </span>
      </div>
    </motion.li>
  );
}
