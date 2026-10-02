import { db, must } from "../supabase";
import type { AudioClip } from "../types";

export const CLIPS_BUCKET = "clips";

let bucketReady: Promise<void> | undefined;

// The bucket is private; playback goes through /api/clips/[id], never a public URL.
async function ensureBucket() {
  bucketReady ??= (async () => {
    const { data } = await db().storage.getBucket(CLIPS_BUCKET);
    if (data) return;
    const { error } = await db().storage.createBucket(CLIPS_BUCKET, { public: false, fileSizeLimit: "8MB" });
    // A parallel caller may have created it first; that's fine.
    if (error && !/exists/i.test(error.message)) throw new Error(`clips bucket: ${error.message}`);
  })();
  return bucketReady;
}

export async function saveClip(
  wav: Uint8Array,
  meta: Omit<AudioClip, "id" | "path" | "bytes" | "created_at">,
): Promise<AudioClip> {
  await ensureBucket();
  const path = `${meta.device_id}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`;
  const up = await db().storage.from(CLIPS_BUCKET).upload(path, wav, { contentType: "audio/wav", upsert: false });
  if (up.error) throw new Error(`clip upload: ${up.error.message}`);
  return must(
    await db()
      .from("audio_clips")
      .insert({ ...meta, path, bytes: wav.byteLength })
      .select("*")
      .single(),
  );
}

export async function listClips(deviceId: string, limit = 20): Promise<AudioClip[]> {
  try {
    return must(
      await db().from("audio_clips").select("*").eq("device_id", deviceId).order("created_at", { ascending: false }).limit(limit),
    ) as AudioClip[];
  } catch (err) {
    console.error("[clips] not listed (has 0003_audio.sql been run?):", (err as Error).message);
    return [];
  }
}

export async function getClip(id: string): Promise<AudioClip | null> {
  return must(await db().from("audio_clips").select("*").eq("id", id).maybeSingle());
}

export async function readClip(clip: AudioClip): Promise<ArrayBuffer> {
  const { data, error } = await db().storage.from(CLIPS_BUCKET).download(clip.path);
  if (error || !data) throw new Error(`clip download: ${error?.message ?? "missing"}`);
  return data.arrayBuffer();
}

export async function deleteClip(clip: AudioClip) {
  await db().storage.from(CLIPS_BUCKET).remove([clip.path]);
  must(await db().from("audio_clips").delete().eq("id", clip.id).select("id"));
}

// 0004_transcripts.sql adds these columns; without it the clip simply keeps no text.
export async function saveTranscript(clip: AudioClip, text: string, model: string): Promise<AudioClip> {
  const res = await db()
    .from("audio_clips")
    .update({ transcript: text, transcript_model: model })
    .eq("id", clip.id)
    .select("*")
    .single();
  if (res.error) {
    if (/transcript/.test(res.error.message)) {
      console.error("[clips] transcript not stored (has 0004_transcripts.sql been run?)");
      return { ...clip, transcript: text, transcript_model: model };
    }
    throw new Error(res.error.message);
  }
  return res.data as AudioClip;
}
