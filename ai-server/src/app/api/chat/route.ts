import { convertToModelMessages, createUIMessageStreamResponse, toUIMessageStream, type UIMessage } from "ai";
import { masterInstructions, masterTools } from "@/agent/master";
import { calendarAvailable } from "@/lib/calendar";
import { ensureWebConsoleDevice } from "@/lib/db/devices";
import { logEvent } from "@/lib/db/events";
import { addMessage, addSessionUsage, getOrCreateSession } from "@/lib/db/sessions";
import { getLlmSettings } from "@/lib/db/settings";
import { languageModel, streamChat } from "@/lib/llm";

export const dynamic = "force-dynamic";
// Delegated device turns and approvals can take a while.
export const maxDuration = 900;

const MASTER_STEPS = 20;

function textOf(m: UIMessage | undefined) {
  return m?.parts.map((p) => (p.type === "text" ? p.text : "")).join("") ?? "";
}

// The master console. `id` is the useChat id, a UUID reused as the session id.
export async function POST(req: Request) {
  const { id, messages }: { id: string; messages: UIMessage[] } = await req.json();
  const settings = await getLlmSettings();
  try {
    languageModel(settings.model);
  } catch (err) {
    return new Response((err as Error).message, { status: 400 });
  }
  const device = await ensureWebConsoleDevice();
  const prompt = textOf(messages.at(-1));
  const session = await getOrCreateSession({ id, deviceId: device.id, title: prompt, model: settings.model });
  await addMessage({ session_id: session.id, device_id: device.id, role: "user", content: prompt, tokens: 0, origin: "web" });

  const result = streamChat(settings, await convertToModelMessages(messages), req.signal, {
    tools: masterTools(session.id, await calendarAvailable()),
    maxSteps: MASTER_STEPS,
    instructionsSuffix: await masterInstructions(),
  });

  // Persist once the stream has finished, without holding up the response.
  Promise.all([result.steps, result.usage])
    .then(async ([steps, usage]) => {
      const reply = steps.map((s) => s.text).filter(Boolean).join("\n\n");
      const toolCalls = steps.flatMap((s) => s.toolCalls.map((c) => c.toolName));
      const input = usage.inputTokens ?? 0;
      const output = usage.outputTokens ?? 0;
      await addMessage({ session_id: session.id, device_id: device.id, role: "assistant", content: reply, tokens: output, origin: "web" });
      await addSessionUsage(session, input, output, settings.model);
      await logEvent({
        device_id: device.id,
        type: "chat",
        summary: `master: “${prompt.slice(0, 80)}” → ${reply.slice(0, 120)}`,
        payload: { session_id: session.id, model: settings.model, input_tokens: input, output_tokens: output, tools: toolCalls },
      });
    })
    .catch((err) =>
      logEvent({ device_id: device.id, type: "error", level: "error", summary: `master console: ${err.message}` }).catch(() => {}),
    );

  return createUIMessageStreamResponse({
    stream: toUIMessageStream({ stream: result.stream, onError: (err) => (err as Error).message }),
  });
}
