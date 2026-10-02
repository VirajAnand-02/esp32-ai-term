import { Panel } from "./primitives";

const ART = String.raw`
  [server] ──── ✕ ──── [supabase]
`;

// Shown in place of a page when the database can't be reached or isn't configured yet.
export function LinkDown({ error }: { error: string }) {
  const envMissing = /environment|not set|SUPABASE/i.test(error);
  return (
    <Panel title="link down" accent="err" className="mx-auto max-w-2xl">
      <pre className="text-center text-sm text-err glow-err">{ART}</pre>
      <p className="mt-2 text-xs text-err">!! {error.split("\n")[0]}</p>
      <pre className="mt-2 whitespace-pre-wrap text-[11px] text-muted">{error.split("\n").slice(1).join("\n")}</pre>
      <div className="mt-4 space-y-1 text-xs text-fg/80">
        {envMissing ? (
          <>
            <p><span className="text-amber-dim">1.</span> Fill in <span className="text-amber">.env.local</span> (see .env.example).</p>
            <p><span className="text-amber-dim">2.</span> Run <span className="text-amber">supabase/migrations/0001_init.sql</span> in the Supabase SQL editor.</p>
            <p><span className="text-amber-dim">3.</span> Optional: <span className="text-amber">pnpm seed</span> for demo data, then restart the server.</p>
          </>
        ) : (
          <p>Check the Supabase project is running and the migration in <span className="text-amber">supabase/migrations</span> has been applied.</p>
        )}
      </div>
    </Panel>
  );
}

export async function load<T>(fn: () => Promise<T>): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
