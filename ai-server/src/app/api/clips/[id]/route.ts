import { getClip, readClip, deleteClip } from "@/lib/db/clips";

export const dynamic = "force-dynamic";

// Streams the WAV through the server, so the storage bucket can stay private.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const clip = await getClip(id);
  if (!clip) return new Response("no such clip", { status: 404 });
  const wav = await readClip(clip);
  return new Response(wav, {
    headers: {
      "Content-Type": "audio/wav",
      "Content-Length": String(wav.byteLength),
      "Content-Disposition": `inline; filename="${clip.created_at.slice(0, 19).replace(/[:T]/g, "-")}.wav"`,
      "Cache-Control": "private, max-age=3600",
    },
  });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const clip = await getClip(id);
  if (!clip) return Response.json({ error: "no such clip" }, { status: 404 });
  await deleteClip(clip);
  return Response.json({ ok: true });
}
