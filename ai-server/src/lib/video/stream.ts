import { randomUUID } from "node:crypto";
import type { DeviceLink } from "@/lib/live";
import { sendToDevice } from "@/agent/run";
import { MjpegSplitter } from "./mjpeg";
import { isLive, transcode, type TranscodeOptions, type VideoSource } from "./ffmpeg";

// Drives one playback: ffmpeg on one side, a device with a small buffer on the other,
// and flow control in between so the slow end sets the pace.
//
// Three things stop this flooding the device, because one is not enough:
//   1. credit — the device says how many frames and bytes it has room for
//   2. one outstanding ws.send at a time — the socket's own completion is the ack
//   3. a bufferedAmount watermark, which pauses ffmpeg itself

const MEDIA_VIDEO = 1;
const MEDIA_AUDIO = 2;
const HEADER_BYTES = 8; // 8, not 7: the payload after it must be 2-byte aligned
                        // or the device reads PCM off an odd address and it
                        // comes out distorted.

const WATERMARK = 48 * 1024; // pause ffmpeg above this much queued on the socket
const IDLE_TIMEOUT_MS = 10_000; // no credit back for this long: assume the device is gone
// Bytes per audio message. Bigger is better here: every message competes with the
// video frames for one serialised channel, so 2048 meant 40 messages a second at
// 40 kHz and squeezed the frames out. 8192 is ~100 ms of audio, a tenth of the
// message count, and still far inside the device's two-second ring.
const AUDIO_CHUNK = 4096; // ~93 ms at 22.05 kHz: few enough messages to stay out of
                          // the video's way, small enough to keep the ring responsive

export const VIDEO_DEFAULTS: TranscodeOptions = {
  // The full panel. 200x200 was tried for the frame rate and does run faster, but a
  // 20 px black border on every side of a 1.3" screen costs more than the smoothness
  // is worth.
  width: 240,
  height: 240,
  // ~16 fps is flat out at 240x240; a target of 12 delivered a measured 10.4 with
  // sound. See MUTED_FPS for what is worth asking when there is no audio task.
  fps: 12,
  // 40 kHz was tried at the amp's suggestion and measurably costs frame rate: 10.4 fps
  // at 22.05 against 6-9 across every scheduler variant at 40, because the audio task
  // does twice the work on the core shared with wifi. It also did not fix the
  // distortion, which is what the higher rate was meant to address. Not worth it into
  // a small mono speaker that resolves little above ~10 kHz.
  audioRate: 22050,
  // Quality barely affects the device's frame time (it is bus-bound at 20 MHz), so
  // there is nothing to gain by sending a worse picture.
  quality: 5,
};

// Silent plays ask for a bit more, though the gain is smaller than it looks: measured
// 10.4 fps against 9.8 with sound, about 6%. The audio task was never the expensive
// part — decode is — so this buys a little, not a lot. Asking for 15 does yield the
// most shown frames of any configuration tested, at the cost of more arriving too late
// to use.
export const MUTED_FPS = 15;

// How far one press of left or right moves. Ten seconds is small enough to land
// where you meant on a short clip and big enough to be worth pressing twice.
const SEEK_MS = 10_000;

type Pending = { kind: number; pts: number; payload: Buffer };

let nextStreamNo = 1;

export class VideoStream {
  readonly id = randomUUID();
  private readonly streamNo = nextStreamNo++ & 0xffff;
  // Set when the first media actually appears, not when the object is built:
  // ffmpeg and yt-dlp can take seconds to produce anything, and counting that
  // startup into the timeline puts every frame in the future.
  private t0 = 0;

  private videoCredit = 0;
  private audioCredit = 0;
  // Kept apart on purpose. A video backlog must never throttle audio: audio is the
  // clock the device synchronises against, and starving it freezes the picture too.
  private videoQueue: Pending[] = [];
  private audioQueue: Pending[] = [];
  private sending = false;
  private stopped = false;
  private lastCreditAt = Date.now();
  private idleTimer?: ReturnType<typeof setInterval>;

  private ff?: Awaited<ReturnType<typeof transcode>>;
  // What is playing and where, so a seek can start the same source somewhere else.
  private source?: VideoSource;
  private title?: string;
  private baseMs = 0;         // where this transcode started in the source
  private startedAt = 0;      // when it started, so position is base + elapsed
  private pausedAt = 0;       // 0 when running
  private paused = false;
  // Bumped whenever the transcode is replaced. A seek kills the old ffmpeg, and its
  // exit would otherwise look exactly like the video reaching its end — which ended
  // playback on every seek until this was here.
  private gen = 0;
  private audioStream?: import("node:stream").Readable;
  private audioTail: Buffer = Buffer.alloc(0);

  shown = 0;
  dropped = 0;
  // Why pump() could not send. Guessing at this has been wrong three times.
  private audioSent = 0;
  private audioBytes = 0;
  private blockedNoAudioCredit = 0;
  private blockedNoVideoCredit = 0;
  private idle = 0;

  constructor(
    private readonly link: DeviceLink,
    private readonly opts: TranscodeOptions = VIDEO_DEFAULTS,
  ) {}

  async start(source: VideoSource, title?: string): Promise<void> {
    this.source = source;
    this.title = title;
    await this.spawn();
    if (this.stopped) return;

    sendToDevice(this.link, {
      type: "video.start",
      id: this.id,
      w: this.opts.width,
      h: this.opts.height,
      fps: this.opts.fps,
      stream: this.streamNo,
      audio: this.ff?.hasAudioTrack ? { rate: this.opts.audioRate, channels: 1 } : null,
      title,
    });

    this.idleTimer = setInterval(() => {
      if (this.paused) return; // a paused stream is not a stalled one
      if (Date.now() - this.lastCreditAt > IDLE_TIMEOUT_MS) this.stop("the device stopped asking for frames");
    }, 2000);
  }

  // Starts ffmpeg at this.baseMs. Called again by seek, which is why the device is
  // told about the stream separately: a seek is a new transcode, not a new stream.
  private async spawn(): Promise<void> {
    const mine = this.gen;
    const ff = await transcode(this.source!, { ...this.opts, startMs: this.baseMs });
    if (this.stopped || mine !== this.gen) return ff.stop();
    this.ff = ff;
    this.startedAt = Date.now();
    const current = () => mine === this.gen && !this.stopped;

    const splitter = new MjpegSplitter((jpeg) => current() && this.enqueue(MEDIA_VIDEO, jpeg));
    ff.video.on("data", (c: Buffer) => splitter.push(c));
    ff.video.on("end", () => current() && this.finishWhenDrained());
    ff.video.on("error", (e: Error) => current() && this.stop(`video: ${e.message}`));

    // The audio socket only exists once ffmpeg connects to it.
    void ff.audio.then((stream) => {
      if (!stream || !current()) return;
      this.audioStream = stream;
      stream.on("data", (c: Buffer) => current() && this.enqueueAudio(c));
      stream.on("error", () => {}); // losing audio is not worth killing the video for
    });

    void ff.exited.then(() => current() && this.finishWhenDrained());
  }

  /** Where playback has reached, in the source's own timeline. */
  private positionMs(): number {
    const running = this.paused ? this.pausedAt - this.startedAt : Date.now() - this.startedAt;
    return this.baseMs + Math.max(0, running);
  }

  /** The device's transport keys. Seeking restarts the transcode at a new offset. */
  control(action: "pause" | "resume" | "seek_back" | "seek_fwd"): void {
    if (this.stopped) return;
    if (action === "pause" || action === "resume") {
      const want = action === "pause";
      if (want === this.paused) return;
      if (want) {
        this.pausedAt = Date.now();
        this.paused = true;
      } else {
        // Shift the start so the elapsed time does not include the pause.
        this.startedAt += Date.now() - this.pausedAt;
        this.paused = false;
        this.pausedAt = 0;
      }
      sendToDevice(this.link, { type: "video.pause", id: this.id, paused: this.paused });
      // ffmpeg keeps running and blocks on a full pipe, which is the cheapest
      // pause there is: no restart, and it picks straight up where it left off.
      if (!this.paused) this.pump();
      return;
    }

    if (isLive(this.source!)) return; // nothing to seek in a screen or webcam feed
    const delta = action === "seek_fwd" ? SEEK_MS : -SEEK_MS;
    const target = Math.max(0, this.positionMs() + delta);
    void this.reseek(target);
  }

  private async reseek(targetMs: number): Promise<void> {
    this.gen++; // anything the outgoing transcode says from here on is stale
    this.ff?.stop();
    this.videoQueue = [];
    this.audioQueue = [];
    this.audioTail = Buffer.alloc(0);
    this.audioStream = undefined;
    this.baseMs = targetMs;
    this.paused = false;
    this.pausedAt = 0;
    // Everything the device has buffered belongs to where we just were; showing
    // any of it would be a visible jump backwards before the jump forwards.
    sendToDevice(this.link, { type: "video.flush", id: this.id });
    sendToDevice(this.link, { type: "video.pause", id: this.id, paused: false });
    await this.spawn();
    this.pump();
  }

  /** The device has room; send until it does not. */
  credit(videoCredits: number, audioCredits: number): void {
    // Additive: the device grants room it has just freed, so bytes already in flight
    // are never double counted.
    this.videoCredit += videoCredits;
    this.audioCredit += audioCredits;
    this.lastCreditAt = Date.now();
    this.pump();
  }

  stop(reason: string): void {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.idleTimer);
    this.ff?.stop();
    this.videoQueue = [];
    this.audioQueue = [];
    const secs = this.t0 ? (Date.now() - this.t0) / 1000 : 0;
    console.log(
      `[video] ${reason} after ${secs.toFixed(1)}s — sent ${this.shown} frames, dropped ${this.dropped}; ` +
        `audio ${this.audioSent} msgs (${(this.audioBytes / 1024).toFixed(0)} KB, ` +
        `${secs ? (this.audioBytes / 1024 / secs).toFixed(0) : 0} KB/s); ` +
        `blocked: no-audio-credit ${this.blockedNoAudioCredit}, no-video-credit ${this.blockedNoVideoCredit}, ` +
        `idle ${this.idle}`,
    );
    sendToDevice(this.link, { type: "video.stop", id: this.id, reason });
    if (this.link.video === this) this.link.video = undefined;
  }

  // ── plumbing ──────────────────────────────────────────────────────────

  private enqueue(kind: number, payload: Buffer): void {
    if (this.stopped) return;
    if (!this.t0) this.t0 = Date.now();
    const item: Pending = { kind, pts: Date.now() - this.t0, payload };
    if (kind === MEDIA_VIDEO) {
      this.videoQueue.push(item);
      // Drop the oldest rather than stall: a late frame is worth nothing, and holding
      // the pipeline back would starve the audio behind it.
      while (this.videoQueue.length > 8) {
        this.videoQueue.shift();
        this.dropped++;
      }
    } else {
      this.audioQueue.push(item);
      // Should never trip: the device consumes audio at real time and ffmpeg makes it
      // at real time. Bounded anyway so a stalled device cannot grow this for ever.
      while (this.audioQueue.length > 96) this.audioQueue.shift();
    }
    this.pump();
  }

  private enqueueAudio(chunk: Buffer): void {
    // Even chunks keep the device's ring predictable.
    this.audioTail = this.audioTail.length ? Buffer.concat([this.audioTail, chunk]) : chunk;
    while (this.audioTail.length >= AUDIO_CHUNK) {
      this.enqueue(MEDIA_AUDIO, this.audioTail.subarray(0, AUDIO_CHUNK));
      this.audioTail = this.audioTail.subarray(AUDIO_CHUNK);
    }
  }

  private pump(): void {
    if (this.sending || this.stopped || this.paused) return;
    const ws = this.link.ws;
    if (ws.readyState !== ws.OPEN) return this.stop("device disconnected");

    // Let the socket drain rather than piling on; the send callback pumps again.
    if (ws.bufferedAmount > WATERMARK) return;


    // Audio must not run dry — the device's clock stops with it — but strict audio
    // priority starves video instead: audio is many small messages and its queue is
    // almost never empty, so video never gets a slot. Send audio in short bursts
    // proportional to how much more often it needs to go out, then let a frame through.
    const canAudio = this.audioQueue.length > 0 && this.audioCredit >= this.audioQueue[0].payload.length;
    const canVideo = this.videoQueue.length > 0 && this.videoCredit > 0;

    // Audio first and ungated. It cannot monopolise the channel — ffmpeg only makes
    // ~80 KB/s of it — and the measurement showed the earlier per-frame gate simply
    // throttled audio to whatever the video rate happened to be (73 KB/s at 8.9 fps
    // against the 80 it needed). Video was never short of channel, it was short of
    // credit: 353 blocked cycles on video credit against 5 on audio.
    let item: Pending | undefined;
    if (canAudio) {
      item = this.audioQueue.shift();
      this.audioCredit -= item!.payload.length;
      this.audioSent++;
      this.audioBytes += item!.payload.length;
    } else if (canVideo) {
      item = this.videoQueue.shift();
      this.videoCredit--;
      this.shown++;
    }
    if (!item) {
      // Nothing sendable: record whether that was want-but-no-credit, or nothing queued.
      if (this.audioQueue.length && !canAudio) this.blockedNoAudioCredit++;
      else if (this.videoQueue.length && !canVideo) this.blockedNoVideoCredit++;
      else this.idle++;
      return;
    }

    const msg = Buffer.allocUnsafe(HEADER_BYTES + item.payload.length);
    msg.writeUInt8(item.kind, 0);
    msg.writeUInt8(0, 1); // reserved, and the byte that buys the alignment
    msg.writeUInt16LE(this.streamNo, 2);
    msg.writeUInt32LE(item.pts, 4);
    item.payload.copy(msg, HEADER_BYTES);

    this.sending = true;
    ws.send(msg, { binary: true }, (err) => {
      this.sending = false;
      if (err) return this.stop(`send failed: ${err.message}`);
      this.pump();
    });
  }

  private finishWhenDrained(): void {
    if (this.stopped) return;
    if (this.videoQueue.length === 0 && this.audioQueue.length === 0) this.stop("finished");
    else setTimeout(() => this.finishWhenDrained(), 250);
  }
}
