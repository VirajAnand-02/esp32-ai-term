import { getDevice } from "@/lib/db/devices";
import { getSession, latestSession, sessionMessages } from "@/lib/db/sessions";
import { listClips } from "@/lib/db/clips";
import { listToolCalls } from "@/lib/db/tool-calls";
import { live } from "@/lib/live";
import { transcriptionAvailable } from "@/lib/transcribe";

export const dynamic = "force-dynamic";

// Snapshot of a device's live session for the dashboard; SSE carries the updates after this.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const device = await getDevice(id);
  if (!device) return Response.json({ error: "no such device" }, { status: 404 });

  const link = live.link(id);
  // Online: the server-owned active session (null right after "new session"). Offline: the latest one, read-only.
  const session = link ? (link.activeSessionId ? await getSession(link.activeSessionId) : null) : await latestSession(id);
  const [messages, toolCalls] = session ? await Promise.all([sessionMessages(session.id), listToolCalls(session.id)]) : [[], []];
  const clips = await listClips(id);

  return Response.json({
    online: Boolean(link),
    access: link?.access ?? null,
    protocol: link?.protocol ?? null,
    tools: (link?.tools ?? []).map((t) => ({ name: t.name, risk: t.risk, description: t.description })),
    running: link?.run ? { origin: link.run.origin } : null,
    wifi: link?.wifi ?? null,
    session: session ? { id: session.id, title: session.title, started_at: session.started_at, model: session.model } : null,
    messages,
    toolCalls,
    clips,
    canRecord: Boolean(link?.tools.some((t) => t.name === "record_audio")),
    canTranscribe: transcriptionAvailable(),
    recording: Boolean(link?.upload),
  });
}
