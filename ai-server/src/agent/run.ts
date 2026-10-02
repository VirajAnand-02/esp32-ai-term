import { dynamicTool, jsonSchema, tool, type ToolSet } from "ai";
import { randomUUID } from "node:crypto";
import type { Outbound } from "@/gateway/protocol";
import { imageForPanel } from "./images";
import { fleetGuidance, fleetRoster, fleetTools } from "./master";
import { calendarGuidance, calendarTools } from "./calendar";
import { memoryBlock, memoryGuidance, memoryTools } from "./memory";
import { peerTools } from "./peers";
import { videoCapable, videoTools } from "./video";
import { publish } from "@/lib/bus";
import { calendarAvailable } from "@/lib/calendar";
import { searchAvailable, webSearch } from "@/lib/search";
import { logEvent } from "@/lib/db/events";
import { addMessage, addSessionUsage, getOrCreateSession, recentMessages } from "@/lib/db/sessions";
import { getLlmSettings } from "@/lib/db/settings";
import { saveToolCall } from "@/lib/db/tool-calls";
import { languageModel, streamChat } from "@/lib/llm";
import type { DeviceLink, ToolResult } from "@/lib/live";
import type { Origin, SessionFrame, ToolCallRow, ToolSpec } from "@/lib/types";

const TOOL_TIMEOUT_MS = 60_000;
const APPROVAL_TIMEOUT_MS = 10 * 60_000;
const MAX_STEPS = 12;
const STORED_OUTPUT = 4_000;

export class AgentBusyError extends Error {}

export function sendToDevice(link: DeviceLink, msg: Outbound) {
  if (link.ws.readyState === link.ws.OPEN) link.ws.send(JSON.stringify(msg));
}

// What the turn is doing, for the splash the device shows after a mic press. Only the
// device gets it: the dashboard already watches the tool rows go by, in more detail
// than a one-line label could give it.
function stage(link: DeviceLink, label: string, detail?: string) {
  sendToDevice(link, { type: "stage", label, ...(detail ? { detail } : {}) });
}

// Binary frames go to the device the same way audio comes back from it.
export function sendBytesToDevice(link: DeviceLink, bytes: Uint8Array) {
  if (link.ws.readyState === link.ws.OPEN) link.ws.send(bytes, { binary: true });
}

export function publishSession(link: DeviceLink, frame: SessionFrame) {
  publish({ kind: "session", deviceId: link.device.id, frame });
}

async function instructions(link: DeviceLink): Promise<string> {
  const d = link.device;
  const lines = [`You are talking through the device "${d.name}" (${d.kind}${d.hw ? `, ${d.hw}` : ""}).`];

  if (link.tools.some((t) => t.name === "display_text")) {
    lines.push(
      "Your answer appears on this device's 240x240 screen: roughly 20 characters a line, nine lines, and the user cannot scroll back.",
      "- Answer in one or two short sentences. Under 140 characters. Do not pad, do not restate the question, do not offer follow-ups.",
      "- Plain text only: markdown, bullet lists, code fences and tables do not render and just waste the space.",
      "- When you draw on the screen or show an image, that is the answer. Say a handful of words at most, or nothing but a short confirmation: whatever you drew stays on the panel, and a long reply is wasted.",
    );
  }
  if (searchAvailable()) {
    lines.push(
      "- You have web_search. Any url you need — a video, a page, a download — comes from a search result, never from memory: a url you wrote yourself will look right and not exist.",
      "- Search too for anything recent or anything you are unsure of, then answer from what came back.",
    );
  }
  if (await calendarAvailable()) lines.push(...calendarGuidance());
  if (link.tools.length) {
    const level = link.access?.level ?? "standard";
    lines.push(
      `You have tools that run directly on the user's own computer. Access level: ${level}.`,
      "- Prefer reading and inspecting over changing anything. Use the smallest action that answers the request.",
      "- Before modifying files, deleting, or running commands, say in one line what you are about to do and why.",
      "- The user's local policy decides every call. Some need their approval; some are denied outright.",
      "  If a call is denied, do not retry it or work around it: explain what was blocked and suggest what they can do.",
      "- '~' is the user's home folder. New files you create belong in ~/aiterm-workspace unless asked otherwise.",
      "- Keep tool output summaries short; the user can see the calls themselves.",
    );
    if (level === "yolo") lines.push("- YOLO mode is on: nothing will be blocked, so be extra careful and never do anything irreversible unasked.");
  }
  // Both scopes: everything global, plus whatever is known about this terminal. Ahead
  // of the fleet block so the roster stays the last thing read, and rebuilt every turn
  // — so editing a memory in the dashboard takes effect on the next answer with no
  // session reset.
  lines.push(...(await memoryBlock(d.id)), "", ...memoryGuidance());
  // This device is also a way into the rest of the fleet: the person standing here can
  // reach any other device through it, without walking over to the dashboard.
  const { roster, hasPeers } = await fleetRoster(d.id);
  lines.push(
    "",
    "You can also see and command the other devices. The fleet:",
    roster,
    "",
    ...fleetGuidance(hasPeers),
    `- Anything about this device you do yourself; "${d.name}" is where you already are.`,
  );
  return lines.join("\n");
}

function buildTools(link: DeviceLink, sessionId: string, hasCalendar: boolean): ToolSet {
  const tools: ToolSet = {};
  for (const spec of link.tools) {
    tools[spec.name] = dynamicTool({
      description: spec.description,
      inputSchema: jsonSchema(spec.parameters as Parameters<typeof jsonSchema>[0]),
      execute: async (args, { toolCallId, abortSignal }) => {
        const result = await callOnDevice(link, sessionId, spec, toolCallId, args, abortSignal);
        if (result.ok) return result.output ?? "";
        if (result.denied) return `DENIED by the user's local policy: ${result.error}. Do not retry this call.`;
        return `ERROR: ${result.error}`;
      },
    });
  }
  // The panel is the giveaway that this device can show a picture at all.
  if (link.tools.some((t) => t.name === "display_text")) tools.show_image = imageTool(link, sessionId);
  // Nothing device-specific about searching; it is on wherever the key is set.
  if (searchAvailable()) tools.web_search = searchTool(link, sessionId);
  // The same fleet tools the master console has. Every device is an access point to the
  // rest, and each call still answers to the target device's own policy.
  Object.assign(tools, fleetTools(sessionId, { caller: link.device.name, self: link.device.id }));
  // Remembering, with this device as the device scope. The closure carries the risk
  // through, which the video one cannot — a read and a delete are not the same thing.
  Object.assign(
    tools,
    memoryTools({
      self: link.device.id,
      run: (name, args, body, risk) => runHere(link, sessionId, name, args, body, risk),
    }),
  );
  // Reading back a task that was handed off to an attached agent. Always present: with
  // no agents configured it simply reports that nothing is outstanding.
  Object.assign(
    tools,
    peerTools({ run: (name, args, body, risk) => runHere(link, sessionId, name, args, body, risk) }),
  );
  // Nothing device-specific about a calendar either; it is on wherever the ICS url
  // has been set.
  if (hasCalendar) {
    Object.assign(
      tools,
      calendarTools({ run: (name, args, body, risk) => runHere(link, sessionId, name, args, body, risk) }),
    );
  }
  // Video needs firmware support, so it is gated on what the device said in hello.
  if (videoCapable(link)) {
    Object.assign(
      tools,
      videoTools(link, (name, args, body) => runHere(link, sessionId, name, args, body)),
    );
  }
  return tools;
}

// Sends tool.call to the device and waits for its tool.result (see gateway: tool.pending / tool.result).
// Also used by the master console, whose calls belong to its own session but land on this device.
export async function callOnDevice(
  link: DeviceLink,
  sessionId: string,
  spec: ToolSpec,
  callId: string,
  args: unknown,
  abortSignal?: AbortSignal,
): Promise<ToolResult> {
  const row: ToolCallRow = {
    id: callId,
    session_id: sessionId,
    device_id: link.device.id,
    name: spec.name,
    args: (args ?? {}) as Record<string, unknown>,
    risk: spec.risk,
    status: "running",
    reason: null,
    output: null,
    decided_by: null,
    created_at: new Date().toISOString(),
    finished_at: null,
  };
  if (link.run) link.run.toolSinceText = true;
  await saveToolCall(row);
  publishSession(link, { type: "tool", call: { ...row } });
  sendToDevice(link, { type: "tool.call", call_id: callId, session_id: sessionId, name: spec.name, args: row.args });
  stage(link, spec.name, "running a tool");

  const result = await new Promise<ToolResult>((resolve) => {
    let timer: ReturnType<typeof setTimeout>;
    const finish = (r: ToolResult) => {
      clearTimeout(timer);
      abortSignal?.removeEventListener("abort", onAbort);
      link.pending.delete(callId);
      resolve(r);
    };
    // Giving up on a call must also tell the device, or its approval prompt would linger.
    const cancel = (why: string) => {
      sendToDevice(link, { type: "tool.cancel", call_id: callId, reason: why });
      finish({ ok: false, error: why });
    };
    const onAbort = () => cancel("aborted by the user");
    const arm = (ms: number, why: string) => {
      clearTimeout(timer);
      timer = setTimeout(() => cancel(why), ms);
    };
    arm(TOOL_TIMEOUT_MS, "the device did not answer in time");
    abortSignal?.addEventListener("abort", onAbort, { once: true });
    link.pending.set(callId, {
      row,
      resolve: finish,
      awaitingApproval: () => arm(APPROVAL_TIMEOUT_MS, "nobody approved the call in time"),
    });
  });

  row.status = result.ok ? "ok" : result.denied ? "denied" : "error";
  row.output = (result.ok ? result.output : result.error)?.slice(0, STORED_OUTPUT) ?? null;
  row.decided_by = result.decided_by ?? row.decided_by;
  row.finished_at = new Date().toISOString();
  await saveToolCall(row);
  publishSession(link, { type: "tool", call: { ...row } });
  return result;
}

// A tool the server runs on the device's behalf. It is recorded and published
// exactly like a device tool, so the live tab does not silently miss it.
async function runHere(
  link: DeviceLink,
  sessionId: string,
  name: string,
  args: Record<string, unknown>,
  body: () => Promise<string>,
  risk = "modify",
): Promise<string> {
  const row: ToolCallRow = {
    id: randomUUID(),
    session_id: sessionId,
    device_id: link.device.id,
    name,
    args,
    risk,
    status: "running",
    reason: null,
    output: null,
    decided_by: "server",
    created_at: new Date().toISOString(),
    finished_at: null,
  };
  if (link.run) link.run.toolSinceText = true;
  await saveToolCall(row);
  publishSession(link, { type: "tool", call: { ...row } });
  stage(link, name, "running a tool");

  let result: string;
  try {
    result = await body();
    row.status = "ok";
  } catch (err) {
    result = `ERROR: ${(err as Error).message}`;
    row.status = "error";
  }
  row.output = result.slice(0, STORED_OUTPUT);
  row.finished_at = new Date().toISOString();
  await saveToolCall(row);
  publishSession(link, { type: "tool", call: { ...row } });
  stage(link, "running agent");
  return result;
}

// Fetching and rescaling an image is far beyond the device, so the server does it
// and sends down a JPEG the panel's decoder can take as-is.
function imageTool(link: DeviceLink, sessionId: string) {
  return tool({
    description:
      "Show a picture on the terminal's screen. Give a url, or a short search phrase to find one. " +
      "The image is cropped and scaled to the 240x240 panel here, so send any size. " +
      "Use this when asked to show, find or look up something visual.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        query: { type: "string", description: "what to find a picture of, if no url is given" },
        url: { type: "string", description: "a direct link to an image" },
        fit: {
          type: "string",
          enum: ["cover", "contain"],
          description: "cover fills the square and crops (good for photos); contain shows all of it with black bars",
        },
      },
      additionalProperties: false,
    } as Parameters<typeof jsonSchema>[0]),
    execute: async (args) =>
      runHere(link, sessionId, "show_image", (args ?? {}) as Record<string, unknown>, async () => {
        const { query, url, fit } = (args ?? {}) as { query?: string; url?: string; fit?: "cover" | "contain" };
        const shot = await imageForPanel({ query, url, fit });
        const id = randomUUID();
        sendToDevice(link, { type: "image.show", id, bytes: shot.jpeg.byteLength, format: "jpeg", note: shot.credit });
        sendBytesToDevice(link, shot.jpeg);
        const kb = Math.round(shot.jpeg.byteLength / 102.4) / 10;
        return `showing it on the panel: ${shot.width}x${shot.height}, ${kb} KB${shot.credit ? ` — ${shot.credit}` : ""}`;
      }),
  });
}

// Asked for a link the model will write a plausible, well-formed, entirely invented one
// rather than say it doesn't know — which is how `play_youtube` ends up failing a minute
// later inside yt-dlp. Real search results are the fix.
function searchTool(link: DeviceLink, sessionId: string) {
  return tool({
    description:
      "Search the web. Returns real page titles, urls and extracts. " +
      "Use it for any url you need, for anything recent, and for anything you are not sure of. " +
      'Never write a url from memory — search and use one of the results. To find something to play, search with site "youtube.com".',
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        query: { type: "string", description: "what to search for" },
        site: { type: "string", description: "restrict to one domain, e.g. youtube.com or wikipedia.org" },
      },
      required: ["query"],
      additionalProperties: false,
    } as Parameters<typeof jsonSchema>[0]),
    execute: async (args) =>
      runHere(
        link,
        sessionId,
        "web_search",
        (args ?? {}) as Record<string, unknown>,
        async () => {
          const { query, site } = (args ?? {}) as { query?: string; site?: string };
          if (!query?.trim()) throw new Error("give something to search for");
          const hits = await webSearch(query, { site });
          if (!hits.length) return `no results for “${query}”${site ? ` on ${site}` : ""}`;
          return hits.map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}\n   ${h.snippet}`).join("\n");
        },
        "read",
      ),
  });
}

export type TurnResult = { sessionId: string | null; reply: string; aborted: boolean; error?: string };

// One user turn in a device's live session, from the device itself or from the dashboard.
export async function runTurn(link: DeviceLink, text: string, origin: Origin, sessionId?: string): Promise<TurnResult> {
  if (link.run) throw new AgentBusyError("the agent is already working on this device; wait for it or abort");
  const abort = new AbortController();
  link.run = { abort, sessionId: null, origin };
  const device = link.device;
  let session: Awaited<ReturnType<typeof getOrCreateSession>> | undefined;
  let reply = "";

  const emit = (frame: SessionFrame & Outbound) => {
    sendToDevice(link, frame);
    publishSession(link, frame);
  };

  try {
    const settings = await getLlmSettings();
    languageModel(settings.model); // fail fast on a missing key, before creating a session
    session = await getOrCreateSession({ id: sessionId ?? link.activeSessionId ?? undefined, deviceId: device.id, title: text, model: settings.model });
    link.activeSessionId = session.id;
    link.run.sessionId = session.id;

    const userFrame = { type: "chat.user" as const, session_id: session.id, text, origin };
    // The device already shows what it typed itself; it only needs prompts from elsewhere.
    if (origin === "web") sendToDevice(link, userFrame);
    publishSession(link, userFrame);

    // Transcription is done and the model is about to run. The device's splash says
    // "transcribing" until something tells it otherwise, and nothing used to.
    stage(link, "running agent", settings.model);

    const history = await recentMessages(session.id);
    await addMessage({ session_id: session.id, device_id: device.id, role: "user", content: text, tokens: 0, origin });

    let streamError: unknown;
    // Whether the calendar is set up lives in the database, not the env, so it is
    // read once here and handed down — rather than making buildTools async for it.
    const hasCalendar = await calendarAvailable();
    // Built unconditionally: search, images and video run on the server, so a device
    // that offers no tools of its own still gets those.
    const tools = buildTools(link, session.id, hasCalendar);
    const result = streamChat(
      settings,
      [
        ...history
          .filter((m) => m.role !== "system")
          .map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
        { role: "user", content: text },
      ],
      abort.signal,
      {
        tools: Object.keys(tools).length ? tools : undefined,
        maxSteps: MAX_STEPS,
        instructionsSuffix: await instructions(link),
        onError: (error) => (streamError = error),
      },
    );

    for await (const chunk of result.textStream) {
      // Text before and after a tool call are separate thoughts; keep them apart in the stored reply.
      if (link.run?.toolSinceText && reply) reply += "\n\n";
      if (link.run) link.run.toolSinceText = false;
      reply += chunk;
      emit({ type: "chat.delta", session_id: session.id, text: chunk });
    }
    if (abort.signal.aborted) throw new DOMException("aborted", "AbortError");
    if (streamError) throw streamError;

    const usage = await result.usage;
    const input = usage.inputTokens ?? 0;
    const output = usage.outputTokens ?? 0;
    await addMessage({ session_id: session.id, device_id: device.id, role: "assistant", content: reply, tokens: output, origin });
    await addSessionUsage(session, input, output, settings.model);
    await logEvent({
      device_id: device.id,
      type: "chat",
      summary: `${origin === "web" ? "[web] " : ""}“${text.slice(0, 80)}” → ${reply.slice(0, 120)}`,
      payload: { session_id: session.id, model: settings.model, input_tokens: input, output_tokens: output, origin },
    });
    // Sent last: the device may send its next chat as soon as it sees chat.done.
    emit({ type: "chat.done", session_id: session.id, usage: { input, output } });
    return { sessionId: session.id, reply, aborted: false };
  } catch (err) {
    if (abort.signal.aborted && session) {
      if (reply) {
        await addMessage({ session_id: session.id, device_id: device.id, role: "assistant", content: `${reply} [aborted]`, tokens: 0, origin }).catch(() => {});
      }
      await logEvent({ device_id: device.id, type: "action", level: "warn", summary: `turn aborted (${origin})` }).catch(() => {});
      emit({ type: "chat.done", session_id: session.id, usage: { input: 0, output: 0 }, aborted: true });
      return { sessionId: session.id, reply, aborted: true };
    }
    const msg = err instanceof Error ? err.message : String(err);
    emit({ type: "error", msg });
    await logEvent({ device_id: device.id, type: "error", level: "error", summary: `agent: ${msg}` }).catch(() => {});
    return { sessionId: session?.id ?? null, reply, aborted: false, error: msg };
  } finally {
    link.run = undefined;
  }
}

export function startNewSession(link: DeviceLink) {
  if (link.run) throw new AgentBusyError("abort the current turn before starting a new session");
  link.activeSessionId = null;
  sendToDevice(link, { type: "session", session_id: null });
  publishSession(link, { type: "session", session_id: null });
}

// Called when the device disconnects: stop the turn and fail anything still waiting on it.
export function dropLink(link: DeviceLink) {
  for (const pending of link.pending.values()) pending.resolve({ ok: false, error: "the device disconnected" });
  for (const waiter of link.clipWaiters.values()) waiter(null, "the device disconnected");
  link.clipWaiters.clear();
  link.upload = undefined;
  link.run?.abort.abort();
}
