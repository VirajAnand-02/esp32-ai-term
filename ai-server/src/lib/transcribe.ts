import { env } from "./env";

// Speech to text through Groq's OpenAI-compatible endpoint. Whisper wants a real
// file, so the WAV goes up as multipart form data.

const ENDPOINT = "https://api.groq.com/openai/v1/audio/transcriptions";

export type Transcription = { text: string; model: string };

export function transcriptionAvailable(): boolean {
  return Boolean(env().GROQ_API_KEY);
}

export async function transcribe(wav: ArrayBuffer | Uint8Array, opts: { language?: string } = {}): Promise<Transcription> {
  const key = env().GROQ_API_KEY;
  if (!key) throw new Error("GROQ_API_KEY is not set, so speech to text is off");

  const model = env().TRANSCRIBE_MODEL;
  const bytes = wav instanceof Uint8Array ? wav : new Uint8Array(wav);
  const form = new FormData();
  form.set("file", new Blob([bytes as BlobPart], { type: "audio/wav" }), "clip.wav");
  form.set("model", model);
  form.set("response_format", "json");
  form.set("temperature", "0");
  if (opts.language) form.set("language", opts.language);
  // No `prompt` hint on purpose: given near-silence Whisper tends to echo it back
  // verbatim, which would look like the user had actually said it.

  const res = await fetch(ENDPOINT, { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`groq ${res.status}: ${detail.slice(0, 300) || res.statusText}`);
  }
  const data = (await res.json()) as { text?: string };
  return { text: (data.text ?? "").trim(), model };
}

// Whisper doesn't return an empty string for silence; it invents one of a small set
// of stock phrases. Anything that short and that generic is treated as nothing said.
const NOISE = new Set([
  "you", "thank you", "thanks", "thanks for watching", "thanks for watching!", "bye", "bye.",
  "thank you.", "thank you for watching", "okay", "ok", "uh", "um", "hmm", "so", "yeah",
  "silence", "[silence]", "[blank_audio]", "(silence)", "subtitles by the amara.org community",
]);

export function looksLikeNothing(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/[.!?,…]+$/g, "").trim();
  if (!t) return true;
  if (!/[a-z0-9]/.test(t)) return true; // only punctuation or music notes
  return NOISE.has(t);
}
