import { readClip, saveTranscript } from "@/lib/db/clips";
import type { DeviceLink } from "@/lib/live";
import { looksLikeNothing, transcribe, transcriptionAvailable } from "@/lib/transcribe";
import type { AudioClip, Origin } from "@/lib/types";
import { runTurn } from "./run";

// Speech to text, shared by the dashboard's mic button and the device's own
// push-to-talk. The text is stored on the clip, so it is only ever paid for once.

export type Heard = { clip: AudioClip; text: string; prompted: boolean; reason?: string };

export async function transcribeClip(clip: AudioClip): Promise<{ clip: AudioClip; text: string }> {
  const { text, model } = await transcribe(await readClip(clip));
  // Whisper never returns an empty string for silence; it invents a stock phrase.
  const clean = looksLikeNothing(text) ? "" : text;
  return { clip: await saveTranscript(clip, clean, model), text: clean };
}

// Transcribes a clip and, if anything was actually said, runs it as a turn on the
// device it came from. The turn streams to the device and to dashboards as usual.
export async function speakToAgent(link: DeviceLink, clip: AudioClip, origin: Origin): Promise<Heard> {
  if (!transcriptionAvailable()) return { clip, text: "", prompted: false, reason: "GROQ_API_KEY is not set" };

  const { clip: stored, text } = await transcribeClip(clip);
  if (!text) return { clip: stored, text: "", prompted: false, reason: "nothing was said" };
  if (link.run) return { clip: stored, text, prompted: false, reason: "the agent is busy" };

  void runTurn(link, text, origin).catch((err) => console.error("[voice]", (err as Error).message));
  return { clip: stored, text, prompted: true };
}
