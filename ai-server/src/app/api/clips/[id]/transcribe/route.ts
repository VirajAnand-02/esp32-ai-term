import { getClip, readClip, saveTranscript } from "@/lib/db/clips";
import { looksLikeNothing, transcribe, transcriptionAvailable } from "@/lib/transcribe";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// Transcribes a clip that has already been recorded, and remembers the text.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!transcriptionAvailable()) return Response.json({ error: "GROQ_API_KEY is not set" }, { status: 501 });

  const clip = await getClip(id);
  if (!clip) return Response.json({ error: "no such clip" }, { status: 404 });
  if (clip.transcript) return Response.json({ ok: true, clip, cached: true });

  try {
    const { text, model } = await transcribe(await readClip(clip));
    const clean = looksLikeNothing(text) ? "" : text;
    return Response.json({ ok: true, clip: await saveTranscript(clip, clean, model) });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 502 });
  }
}
