import { randomUUID } from "node:crypto";
import { z } from "zod";
import { sendToDevice } from "@/agent/run";
import { live } from "@/lib/live";
import type { AudioClip } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const body = z.object({ seconds: z.number().min(1).max(30).default(5) });

// Asks the device to record from its microphone, and waits for the clip to land.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const parsed = body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return Response.json({ error: "seconds must be between 1 and 30" }, { status: 400 });
  const { seconds } = parsed.data;

  const link = live.link(id);
  if (!link) return Response.json({ error: "device is offline" }, { status: 409 });
  if (!link.tools.some((t) => t.name === "record_audio")) {
    return Response.json({ error: "this device has no microphone" }, { status: 409 });
  }
  if (link.upload) return Response.json({ error: "the device is already recording" }, { status: 409 });

  const clipId = randomUUID();
  const clip = await new Promise<AudioClip | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      link.clipWaiters.delete(clipId);
      reject(new Error("the device did not send the clip in time"));
    }, (seconds + 20) * 1000);
    link.clipWaiters.set(clipId, (result, error) => {
      clearTimeout(timer);
      if (error) reject(new Error(error));
      else resolve(result);
    });
    sendToDevice(link, { type: "audio.record", clip_id: clipId, seconds });
  }).catch((err: Error) => {
    link.clipWaiters.delete(clipId);
    return err;
  });

  if (clip instanceof Error) return Response.json({ error: clip.message }, { status: 502 });
  return Response.json({ ok: true, clip });
}
