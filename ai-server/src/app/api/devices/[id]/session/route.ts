import { AgentBusyError, startNewSession } from "@/agent/run";
import { live } from "@/lib/live";

export const dynamic = "force-dynamic";

// Starts a fresh session for the device; the client TUI hears about it too.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const link = live.link(id);
  if (!link) return Response.json({ error: "device is offline" }, { status: 409 });
  try {
    startNewSession(link);
  } catch (err) {
    if (err instanceof AgentBusyError) return Response.json({ error: err.message }, { status: 409 });
    throw err;
  }
  return Response.json({ ok: true });
}
