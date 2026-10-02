import type { Metadata } from "next";
import { LinkDown, load } from "@/components/term/link-down";
import { AsciiBar } from "@/components/term/motion";
import { Button, Led, NotWired, Panel, Tag } from "@/components/term/primitives";
import { tableCounts } from "@/lib/db/stats";
import { env } from "@/lib/env";

export const metadata: Metadata = { title: "databases" };

const PLANNED = [
  { name: "vector store", engine: "pgvector", desc: "Embeddings for semantic memory recall and document search." },
  { name: "knowledge base", engine: "storage + pgvector", desc: "Upload docs and manuals the assistant can cite." },
  { name: "external sql", engine: "postgres / mysql", desc: "Read-only connections the LLM can query through tools." },
  { name: "backups", engine: "pg_dump → storage", desc: "Nightly snapshot of devices, sessions and memories." },
];

async function timedTableCounts() {
  const t0 = performance.now();
  const tables = await tableCounts();
  return { tables, rtt: Math.round(performance.now() - t0) };
}

export default async function DatabasesPage() {
  const res = await load(timedTableCounts);
  if (!res.ok) return <LinkDown error={res.error} />;
  const { tables, rtt } = res.data;

  const host = new URL(env().SUPABASE_URL).host;
  const max = Math.max(1, ...tables.map((t) => t.rows));

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <Panel
        title="primary // supabase"
        accent="phos"
        actions={
          <span className="flex items-center gap-1.5 text-[11px] text-phos">
            <Led on /> connected
          </span>
        }
      >
        <dl className="mb-4 grid grid-cols-3 gap-3 text-[11px]">
          <div>
            <dt className="text-amber-faint">host</dt>
            <dd className="truncate text-fg" title={host}>
              {host}
            </dd>
          </div>
          <div>
            <dt className="text-amber-faint">auth</dt>
            <dd className="text-fg">secret key</dd>
          </div>
          <div>
            <dt className="text-amber-faint">round trip</dt>
            <dd className={rtt > 800 ? "text-warn" : "text-phos"}>{rtt} ms</dd>
          </div>
        </dl>
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-[0.14em] text-amber-dim">
              <th className="pb-2 font-normal">table</th>
              <th className="pb-2 font-normal">rows</th>
              <th className="hidden pb-2 font-normal sm:table-cell" />
              <th className="pb-2 text-right font-normal">ms</th>
            </tr>
          </thead>
          <tbody>
            {tables.map((t) => (
              <tr key={t.table} className="border-t border-dashed border-line">
                <td className="py-1.5 text-fg">{t.table}</td>
                <td className="py-1.5 tabular-nums text-amber">{t.rows.toLocaleString()}</td>
                <td className="hidden py-1.5 sm:table-cell">
                  <AsciiBar value={t.rows / max} width={18} className="text-[11px]" />
                </td>
                <td className="py-1.5 text-right tabular-nums text-muted">{t.ms}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-3 text-[11px] text-amber-faint">RLS is on for every table with no policies; only this server&apos;s secret key can read or write.</p>
      </Panel>

      <div className="grid content-start gap-3 sm:grid-cols-2">
        {PLANNED.map((p) => (
          <Panel key={p.name} title={p.name} actions={<NotWired />} className="opacity-75">
            <Tag tone="muted">{p.engine}</Tag>
            <p className="mt-2 text-xs text-muted">{p.desc}</p>
            <Button size="sm" className="mt-3" disabled>
              configure
            </Button>
          </Panel>
        ))}
      </div>
    </div>
  );
}
