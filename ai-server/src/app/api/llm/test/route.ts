import { createTextStreamResponse, toTextStream } from "ai";
import { z } from "zod";
import { streamChat } from "@/lib/llm";

export const dynamic = "force-dynamic";

const body = z.object({
  model: z.string().min(3),
  temperature: z.number().min(0).max(2).nullable(),
  maxOutputTokens: z.number().int().min(16).max(8192),
  systemPrompt: z.string().max(8000),
  prompt: z.string().min(1).max(2000),
});

// Streams a reply using unsaved settings so the LLM page can try before saving.
export async function POST(req: Request) {
  const parsed = body.safeParse(await req.json());
  if (!parsed.success) return new Response(parsed.error.issues[0]?.message ?? "bad request", { status: 400 });
  const { prompt, ...settings } = parsed.data;
  try {
    const result = streamChat(settings, [{ role: "user", content: prompt }], req.signal);
    return createTextStreamResponse({ stream: toTextStream({ stream: result.stream }) });
  } catch (err) {
    return new Response((err as Error).message, { status: 400 });
  }
}
