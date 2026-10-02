import { readClip } from "@/lib/db/clips";
import type { DeviceLink } from "@/lib/live";
import type { AudioClip } from "@/lib/types";

// Streams a stored voice note back down to the device so it can be played on the
// terminal's own speaker.
//
// Credit-based like the video path, and for the same reason learned there: sending
// as fast as the socket accepts buries the device, and reporting "I have N bytes
// free" races with whatever is still in flight. The device grants "you may send this
// much more", which cannot race.

const HEADER_BYTES = 8; // matches the video framing: kind, pad, stream u16, pts u32
const MEDIA_NOTE = 3; // 1 is video, 2 is video's audio
const CHUNK = 2048; // bytes, ~64 ms at 16 kHz mono
const WAV_HEADER = 44;

export class NotePlayer {
  readonly id: string;
  private pcm: Buffer = Buffer.alloc(0);
  private sent = 0; // bytes handed to the socket
  private credit = 0;
  private stopped = false;
  private sending = false;
  private rate = 16000;

  constructor(
    private readonly link: DeviceLink,
    clip: AudioClip,
  ) {
    this.id = clip.id;
    this.rate = clip.sample_rate || 16000;
  }

  async start(clip: AudioClip): Promise<void> {
    const wav = Buffer.from(await readClip(clip));
    if (this.stopped) return;
    // The clips are written by wavFromPcm, so the header is always the canonical
    // 44 bytes — no need to walk the chunks looking for "data".
    this.pcm = wav.subarray(WAV_HEADER);

    this.send({
      type: "note.start",
      id: this.id,
      rate: this.rate,
      seconds: this.pcm.length / 2 / this.rate,
      from_ms: this.fromMs,
    });
    this.pump();
  }

  /** Where playback began in the clip, so a seek can restart it elsewhere. */
  fromMs = 0;

  seekTo(ms: number): void {
    const at = Math.max(0, Math.floor((ms / 1000) * this.rate) * 2);
    this.sent = Math.min(at, this.pcm.length);
    this.fromMs = ms;
    this.send({ type: "note.seek", id: this.id, from_ms: ms });
    this.pump();
  }

  /** The device has room for this many more bytes. */
  grant(bytes: number): void {
    this.credit += bytes;
    this.pump();
  }

  stop(reason = "stopped"): void {
    if (this.stopped) return;
    this.stopped = true;
    this.send({ type: "note.end", id: this.id, reason });
    if (this.link.note === this) this.link.note = undefined;
  }

  private send(msg: object) {
    const ws = this.link.ws;
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }

  private pump(): void {
    if (this.sending || this.stopped) return;
    const ws = this.link.ws;
    if (ws.readyState !== ws.OPEN) return this.stop("device disconnected");

    if (this.sent >= this.pcm.length) return this.stop("finished");
    if (this.credit < CHUNK) return;

    const end = Math.min(this.sent + CHUNK, this.pcm.length);
    const payload = this.pcm.subarray(this.sent, end);
    const msg = Buffer.allocUnsafe(HEADER_BYTES + payload.length);
    msg.writeUInt8(MEDIA_NOTE, 0);
    msg.writeUInt8(0, 1); // the pad that keeps the PCM on an even address
    msg.writeUInt16LE(0, 2);
    // Milliseconds into the clip, so the device can show a position.
    msg.writeUInt32LE(Math.floor((this.sent / 2 / this.rate) * 1000) + this.fromMs, 4);
    payload.copy(msg, HEADER_BYTES);

    this.sending = true;
    ws.send(msg, { binary: true }, (err) => {
      this.sending = false;
      if (err) return this.stop(`send failed: ${err.message}`);
      this.sent = end;
      this.credit -= payload.length;
      this.pump();
    });
  }
}
