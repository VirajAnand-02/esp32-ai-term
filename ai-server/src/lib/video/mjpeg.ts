// Cuts an MJPEG byte stream into individual JPEGs.
//
// ffmpeg's image2pipe output is just complete JPEGs back to back, so the split is a
// scan for SOI (FFD8) through EOI (FFD9). The awkward part is being robust: a dropped
// byte must not leave the splitter accumulating for ever, so there is a hard cap and a
// resync.

const SOI = 0xd8;
const EOI = 0xd9;
const MARKER = 0xff;

export type FrameSink = (jpeg: Buffer) => void;

export class MjpegSplitter {
  private buf: Buffer = Buffer.alloc(0);
  private started = false;
  /** Frames abandoned because they grew past the cap — a sign of a corrupt stream. */
  resyncs = 0;

  constructor(
    private readonly onFrame: FrameSink,
    private readonly maxFrameBytes = 256 * 1024,
  ) {}

  push(chunk: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;

    for (;;) {
      if (!this.started) {
        const soi = this.indexOfMarker(SOI, 0);
        if (soi < 0) {
          // No start in sight. Keep only a trailing byte, in case FF ended the chunk.
          this.buf = this.buf.subarray(Math.max(0, this.buf.length - 1));
          return;
        }
        if (soi > 0) this.buf = this.buf.subarray(soi);
        this.started = true;
      }

      const eoi = this.indexOfMarker(EOI, 2);
      if (eoi < 0) {
        if (this.buf.length > this.maxFrameBytes) {
          // Never seen an end marker and the buffer is absurd: drop it and resync on
          // the next SOI rather than growing without limit.
          this.resyncs++;
          this.buf = Buffer.alloc(0);
          this.started = false;
        }
        return;
      }

      const end = eoi + 2;
      this.onFrame(this.buf.subarray(0, end));
      this.buf = this.buf.subarray(end);
      this.started = false;
    }
  }

  /** Index of `FF <code>` at or after `from`, or -1. */
  private indexOfMarker(code: number, from: number): number {
    for (let i = from; i < this.buf.length - 1; i++) {
      if (this.buf[i] === MARKER && this.buf[i + 1] === code) return i;
    }
    return -1;
  }
}
