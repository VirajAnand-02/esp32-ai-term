import { z } from "zod";
import { startStream, stopStream, videoCapable } from "@/agent/video";
import { live } from "@/lib/live";
import { hasYtDlp, type VideoSource } from "@/lib/video/ffmpeg";

export const dynamic = "force-dynamic";

const body = z.object({
  action: z.enum(["play", "stop"]).default("play"),
  source: z.enum(["url", "file", "youtube", "screen", "webcam"]).default("url"),
  url: z.string().max(2000).optional(),
  path: z.string().max(1000).optional(),
  device: z.string().max(200).optional(), // webcam name
  mute: z.boolean().default(false),
});

// Dashboard control for the device's screen. The agent has its own tools for this;
// this is the manual path, next to /tool and /listen.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const parsed = body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "bad request" }, { status: 400 });

  const link = live.link(id);
  if (!link) return Response.json({ error: "device is offline" }, { status: 409 });
  if (!videoCapable(link)) return Response.json({ error: "this device's firmware cannot play video" }, { status: 409 });

  const { action, source, url, path, device, mute } = parsed.data;
  if (action === "stop") return Response.json({ ok: true, stopped: stopStream(link, "stopped from the dashboard") });

  let src: VideoSource;
  switch (source) {
    case "url":
      if (!url) return Response.json({ error: "give a url" }, { status: 400 });
      src = { kind: "url", url };
      break;
    case "file":
      if (!path) return Response.json({ error: "give a file path" }, { status: 400 });
      src = { kind: "file", path };
      break;
    case "youtube":
      if (!url) return Response.json({ error: "give a YouTube url" }, { status: 400 });
      if (!(await hasYtDlp())) return Response.json({ error: "yt-dlp is not installed on the server" }, { status: 501 });
      src = { kind: "youtube", url };
      break;
    case "screen":
      if (process.platform !== "win32") {
        return Response.json({ error: "screen capture is only wired up for Windows" }, { status: 501 });
      }
      src = { kind: "screen" };
      break;
    case "webcam":
      if (!device) return Response.json({ error: "name the webcam" }, { status: 400 });
      src = { kind: "webcam", device };
      break;
  }

  const stream = startStream(link, src, url ?? path ?? source, mute);
  return Response.json({ ok: true, id: stream.id });
}

// Whether this device can play video, and what the server can offer it.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const link = live.link(id);
  return Response.json({
    online: Boolean(link),
    capable: link ? videoCapable(link) : false,
    playing: Boolean(link?.video),
    youtube: await hasYtDlp(),
    capture: process.platform === "win32",
  });
}
