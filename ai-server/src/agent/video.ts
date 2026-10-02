import { jsonSchema, tool, type ToolSet } from "ai";
import type { DeviceLink } from "@/lib/live";
import { hasYtDlp, type VideoSource } from "@/lib/video/ffmpeg";
import { MUTED_FPS, VIDEO_DEFAULTS, VideoStream } from "@/lib/video/stream";

// Video tools the server runs on the device's behalf. The ESP32 can neither fetch nor
// transcode anything, so all of that happens here and it receives ready-made frames.

export function videoCapable(link: DeviceLink): boolean {
  return link.capabilities?.includes("video") ?? false;
}

export function startStream(link: DeviceLink, source: VideoSource, title?: string, mute = false): VideoStream {
  link.video?.stop("replaced by a new stream");
  const stream = new VideoStream(link, mutedOptions(mute));
  link.video = stream;
  void stream.start(source, title).catch((e: Error) => stream.stop(e.message));
  return stream;
}

export function stopStream(link: DeviceLink, reason = "stopped"): boolean {
  if (!link.video) return false;
  link.video.stop(reason);
  return true;
}

// Silent playback frees the device's audio task and its share of the link, so it is
// worth asking for more frames at the same time.
function mutedOptions(mute: boolean) {
  return mute ? { ...VIDEO_DEFAULTS, mute: true, fps: MUTED_FPS } : VIDEO_DEFAULTS;
}

const schema = (properties: Record<string, unknown>, required: string[] = []) =>
  jsonSchema({ type: "object", properties, required, additionalProperties: false } as Parameters<
    typeof jsonSchema
  >[0]);

export function videoTools(link: DeviceLink, run: (name: string, args: Record<string, unknown>, body: () => Promise<string>) => Promise<string>): ToolSet {
  const tools: ToolSet = {};

  tools.play_video = tool({
    description:
      "Play a video on the terminal's screen, with sound. Give a direct url to a video file, or a path to one on " +
      "the server. It is scaled and cropped to the 240x240 panel here, so any size or format ffmpeg can read is " +
      "fine. Playback continues after you answer; say only a few words.",
    inputSchema: schema(
      {
        url: { type: "string", description: "a direct link to a video file" },
        path: { type: "string", description: "a video file on the server instead of a url" },
        mute: {
          type: "boolean",
          description: "play silently, which runs noticeably smoother; use it when the sound does not matter",
        },
      },
    ),
    execute: async (args) =>
      run("play_video", (args ?? {}) as Record<string, unknown>, async () => {
        const { url, path, mute } = (args ?? {}) as { url?: string; path?: string; mute?: boolean };
        if (!url && !path) throw new Error("give a url or a file path");
        const source: VideoSource = url ? { kind: "url", url } : { kind: "file", path: path! };
        startStream(link, source, url ?? path, Boolean(mute));
        return `playing on the panel at 240x240${mute ? ", silently" : " with sound"}: ${url ?? path}`;
      }),
  });

  tools.play_youtube = tool({
    description:
      "Play a YouTube video on the terminal's screen, with sound. The url must come from a web_search result — " +
      "a video id written from memory will look perfectly valid and turn out not to exist, and this fails a " +
      "minute later once yt-dlp has tried it.",
    inputSchema: schema(
      {
        url: { type: "string", description: "the YouTube link, as it appeared in a search result" },
        mute: {
          type: "boolean",
          description: "play silently, which runs a little smoother; use it when the sound does not matter",
        },
      },
      ["url"],
    ),
    execute: async (args) =>
      run("play_youtube", (args ?? {}) as Record<string, unknown>, async () => {
        const { url, mute } = (args ?? {}) as { url?: string; mute?: boolean };
        if (!url) throw new Error("give a YouTube url");
        if (!(await hasYtDlp())) throw new Error("yt-dlp is not installed on the server, so YouTube cannot be played");
        startStream(link, { kind: "youtube", url }, url, Boolean(mute));
        return `playing that YouTube video on the panel${mute ? ", silently" : " with sound"}`;
      }),
  });

  tools.mirror_screen = tool({
    description:
      "Mirror this computer's screen onto the terminal's panel, live. Only works while the server runs on the " +
      "user's own machine. Keeps going until stopped.",
    inputSchema: schema({}),
    execute: async (args) =>
      run("mirror_screen", (args ?? {}) as Record<string, unknown>, async () => {
        if (process.platform !== "win32") throw new Error("screen capture is only wired up for Windows (gdigrab)");
        // gdigrab has no audio stream at all, so muting only skips a pointless probe
        // and lets the frame rate target go up.
        startStream(link, { kind: "screen" }, "screen", true);
        return "mirroring the screen onto the panel";
      }),
  });

  tools.stop_video = tool({
    description: "Stop whatever is playing on the terminal's screen and give it back to the interface.",
    inputSchema: schema({}),
    execute: async (args) =>
      run("stop_video", (args ?? {}) as Record<string, unknown>, async () =>
        stopStream(link, "stopped by the agent") ? "stopped" : "nothing was playing",
      ),
  });

  return tools;
}
