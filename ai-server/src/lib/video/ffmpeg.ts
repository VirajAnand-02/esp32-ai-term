import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import type { Readable } from "node:stream";

// One ffmpeg process per stream, producing MJPEG video and raw PCM audio.
//
// Video goes to stdout, which is the ordinary idiom. Audio cannot also go to a pipe:
// Node only gives a child fds 0-2 on Windows, so `pipe:3` fails with "Bad file
// descriptor". ffmpeg will happily write to a TCP socket instead, so audio goes to a
// throwaway listener on localhost. That keeps it to a single decode and works the same
// on Windows and on Linux.

export type VideoSource =
  | { kind: "url"; url: string }
  | { kind: "file"; path: string }
  | { kind: "youtube"; url: string }
  | { kind: "screen" }
  | { kind: "webcam"; device: string };

export type TranscodeOptions = {
  width: number;
  height: number;
  fps: number;
  audioRate: number;
  quality: number; // ffmpeg -q:v, 2 (best) to 31
  /** Start this far into the source. Seeking is implemented as a restart here. */
  startMs?: number;
  /** No sound at all. Frees the device's audio task and buys frame rate. */
  mute?: boolean;
};

export type Transcode = {
  video: Readable;
  hasAudioTrack: boolean;
  audio: Promise<Readable | null>;
  stop: () => void;
  exited: Promise<number | null>;
};

// Live sources are realtime already; everything else needs -re, or ffmpeg reads the
// whole clip as fast as the disk allows.
export function isLive(source: VideoSource): boolean {
  return source.kind === "screen" || source.kind === "webcam";
}

function inputArgs(source: VideoSource): string[] {
  switch (source.kind) {
    case "url":
      return ["-i", source.url];
    case "file":
      return ["-i", source.path];
    case "youtube":
      return ["-i", "pipe:0"]; // yt-dlp is piped in on stdin
    case "screen":
      return ["-f", "gdigrab", "-framerate", "15", "-i", "desktop"];
    case "webcam":
      return ["-f", "dshow", "-i", `video=${source.device}`];
  }
}

// Asking ffmpeg for an audio output when the source has none makes it fail with
// "Output file does not contain any stream", so check first.
export function probeHasAudio(source: VideoSource): Promise<boolean> {
  if (isLive(source)) return Promise.resolve(false);
  if (source.kind === "youtube") return Promise.resolve(true); // assume; yt-dlp picks a muxed stream
  const input = source.kind === "url" ? source.url : source.kind === "file" ? source.path : "";
  if (!input) return Promise.resolve(false);
  return new Promise((resolve) => {
    const probe = spawn("ffprobe", [
      "-v", "error", "-select_streams", "a:0",
      "-show_entries", "stream=codec_type", "-of", "csv=p=0", input,
    ]);
    let out = "";
    probe.stdout.on("data", (b: Buffer) => (out += b.toString()));
    probe.on("error", () => resolve(false));
    probe.on("exit", () => resolve(out.includes("audio")));
  });
}

// Kills a child and anything it started.
//
// This matters more than it looks. ffmpeg on PATH is very often a shim — Chocolatey
// and scoop both install one — which launches the real binary as a child process.
// Killing the pid we hold then kills the shim and orphans the real ffmpeg, which
// carries on holding its input file open. The symptom is a video file that cannot
// be deleted or overwritten after playback, with nothing obviously still running.
function killTree(child: ChildProcess) {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    child.kill("SIGKILL");
  }
}

// A listener that accepts exactly one connection: ffmpeg's audio output.
function audioSink(): Promise<{ port: number; socket: Promise<Socket | null>; server: Server }> {
  return new Promise((resolve) => {
    const server = createServer();
    const socket = new Promise<Socket | null>((gotSocket) => {
      server.once("connection", (s) => gotSocket(s));
      // If ffmpeg never connects, do not wait for ever.
      setTimeout(() => gotSocket(null), 15_000);
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ port, socket, server });
    });
  });
}

export async function transcode(source: VideoSource, opts: TranscodeOptions): Promise<Transcode> {
  // Muted skips the probe as well as the output: no ffprobe spawn, no second encoder,
  // no TCP sink, and the device never starts its audio task.
  const wantAudio = opts.mute ? false : await probeHasAudio(source);
  const sink = wantAudio ? await audioSink() : null;
  const scale = `scale=${opts.width}:${opts.height}:force_original_aspect_ratio=increase`;

  const args = [
    "-hide_banner",
    "-loglevel", "warning",
    ...(isLive(source) ? [] : ["-re"]),
    // Before -i on purpose: that is the indexed seek, which lands more or less
    // instantly. After -i ffmpeg decodes everything up to the point and a 3 minute
    // skip would take seconds.
    ...(opts.startMs && opts.startMs > 0 ? ["-ss", (opts.startMs / 1000).toFixed(3)] : []),
    ...inputArgs(source),
    // video → stdout. mjpeg is baseline by default, which is all the device decodes.
    "-map", "0:v:0",
    "-an",
    "-vf", `fps=${opts.fps},${scale},crop=${opts.width}:${opts.height}`,
    "-c:v", "mjpeg",
    "-q:v", String(opts.quality),
    "-f", "image2pipe", "pipe:1",
  ];
  if (sink) {
    args.push(
      "-map", "0:a:0",
      "-vn",
      "-ac", "1",
      "-ar", String(opts.audioRate),
      // Shaped for a small speaker with no enclosure: the highpass drops bass it
      // cannot reproduce and would only rattle on, and the limiter keeps peaks off
      // the rails so loud passages do not distort.
      "-af", "highpass=f=180,alimiter=limit=0.8:attack=5:release=50",
      "-f", "s16le", `tcp://127.0.0.1:${sink.port}`,
    );
  }

  let child: ChildProcess;
  if (source.kind === "youtube") {
    // Two things YouTube needs that are easy to get wrong:
    //   --js-runtimes node   modern yt-dlp needs a JS runtime to solve YouTube's
    //                        challenge, and only deno is enabled by default
    //   bv*+ba, mkv          YouTube no longer offers muxed formats, so plain "best"
    //                        matches nothing; the streams have to be merged, and
    //                        matroska is the container that survives a pipe
    const dl = spawn(
      resolveYtDlp(),
      [
        "--js-runtimes", "node",
        "-f", "bv*[height<=480]+ba/b[height<=480]/b",
        "--merge-output-format", "mkv",
        "--quiet", "--no-warnings",
        "-o", "-",
        source.url,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    dl.stderr?.on("data", (b: Buffer) => console.error("[yt-dlp]", b.toString().trim().slice(0, 200)));
    child = spawn("ffmpeg", args, { stdio: ["pipe", "pipe", "pipe"] });
    dl.stdout?.pipe(child.stdin!);
    child.on("exit", () => killTree(dl));
  } else {
    child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
  }

  child.stderr?.on("data", (b: Buffer) => {
    const text = b.toString().trim();
    if (text) console.error("[ffmpeg]", text.slice(0, 300));
  });

  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  void exited.then(() => sink?.server.close());

  return {
    video: child.stdout!,
    hasAudioTrack: wantAudio,
    audio: sink ? sink.socket.then((s) => s as Readable | null) : Promise.resolve(null),
    stop: () => {
      // Killed rather than asked politely: ffmpeg can sit on a stalled network input,
      // and a stream being torn down is never worth waiting for.
      killTree(child);
      sink?.server.close();
    },
    exited,
  };
}

let ytdlpChecked: Promise<boolean> | undefined;
let ytdlpPath: string | undefined;

// A binary dropped next to the server counts, not just one on PATH: yt-dlp is a single
// self-contained executable and keeping it in the project is the easiest way to have it.
function resolveYtDlp(): string {
  if (ytdlpPath) return ytdlpPath;
  for (const name of ["yt-dlp.exe", "yt-dlp"]) {
    const local = join(process.cwd(), name);
    if (existsSync(local)) return (ytdlpPath = local);
  }
  return (ytdlpPath = "yt-dlp"); // fall back to PATH
}

// Checked once and cached, so a missing yt-dlp is a clear error rather than a crash.
export function hasYtDlp(): Promise<boolean> {
  ytdlpChecked ??= new Promise<boolean>((resolve) => {
    const probe = spawn(resolveYtDlp(), ["--version"], { stdio: "ignore" });
    probe.on("error", () => resolve(false));
    probe.on("exit", (code) => resolve(code === 0));
  });
  return ytdlpChecked;
}
