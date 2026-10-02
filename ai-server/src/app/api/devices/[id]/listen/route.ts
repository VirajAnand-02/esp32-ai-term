import { randomUUID } from "node:crypto";
import { z } from "zod";
import { sendToDevice } from "@/agent/run";
import { speakToAgent, transcribeClip } from "@/agent/voice";
import { live } from "@/lib/live";
import { transcriptionAvailable } from "@/lib/transcribe";
import type { AudioClip } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 180;

const body = z.object({
  seconds: z.number().min(1).max(30).default(6),
  prompt: z.boolean().default(true), // false just transcribes, without asking the agent
});

// Push to talk: record from the device's microphone, run it through Groq speech to
// text, and hand the transcript to the agent as a prompt in the device's live session.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const parsed = body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return Response.json({ error: "seconds must be between 1 and 30" }, { status: 400 });
  const { seconds, prompt } = parsed.data;

  if (!transcriptionAvailable()) return Response.json({ error: "GROQ_API_KEY is not set" }, { status: 501 });

  const link = live.link(id);
  if (!link) return Response.json({ error: "device is offline" }, { status: 409 });
  if (!link.tools.some((t) => t.name === "record_audio")) {
    return Response.json({ error: "this device has no microphone" }, { status: 409 });
  }
  if (link.upload) return Response.json({ error: "the device is already recording" }, { status: 409 });
  if (prompt && link.run) return Response.json({ error: "the agent is already working on this device" }, { status: 409 });

  const clipId = randomUUID();
  const clip = await new Promise<AudioClip>((resolve, reject) => {
    const timer = setTimeout(() => {
      link.clipWaiters.delete(clipId);
      reject(new Error("the device did not send the clip in time"));
    }, (seconds + 20) * 1000);
    link.clipWaiters.set(clipId, (result, error) => {
      clearTimeout(timer);
      if (error || !result) reject(new Error(error ?? "the device sent no audio"));
      else resolve(result);
    });
    sendToDevice(link, { type: "audio.record", clip_id: clipId, seconds });
  }).catch((err: Error) => {
    link.clipWaiters.delete(clipId);
    return err;
  });
  if (clip instanceof Error) return Response.json({ error: clip.message }, { status: 502 });

  try {
    if (!prompt) {
      const { clip: stored, text } = await transcribeClip(clip);
      return Response.json({ ok: true, clip: stored, text, prompted: false, reason: text ? undefined : "nothing was said" });
    }
    const heard = await speakToAgent(link, clip, "web");
    return Response.json({ ok: true, clip: heard.clip, text: heard.text, prompted: heard.prompted, reason: heard.reason });
  } catch (err) {
    return Response.json({ error: `transcription failed: ${(err as Error).message}`, clip }, { status: 502 });
  }
}
