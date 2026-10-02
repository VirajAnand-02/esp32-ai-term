import { tool, type ToolSet } from "ai";
import { z } from "zod";

import { createMemory, deleteMemory, memoriesFor } from "@/lib/db/memories";
import type { Memory } from "@/lib/types";

// What the agent remembers between sessions.
//
// The table and the dashboard for this have existed since the first migration; the
// `device_id is null = global` convention is its, not something invented here. All
// that was ever missing was a reader, so nothing the agent learnt survived the turn
// it learnt it in.
//
// Two scopes, and the difference is worth stating once rather than being guessed at
// each turn: a device memory is about one terminal — its wiring, its quirks, where
// it sits. A system memory is about the person, and follows them to every device.

// The dashboard's own cap (see the zod schema in app/actions/settings.ts).
const MAX_CONTENT = 2000;
// Enough to be useful, bounded so a long-lived fleet cannot quietly eat the context
// window. Newest first, so what falls off the end is the oldest.
const SHOWN_PER_SCOPE = 40;

// Lets a memory tool record itself in the live tab exactly like any other server-side
// tool. The console has no device to attribute a call to, so it passes nothing and the
// body simply runs — the same way the fleet tools behave there.
export type RunHere = (
  name: string,
  args: Record<string, unknown>,
  body: () => Promise<string>,
  risk?: string,
) => Promise<string>;

const ref = (m: Memory) => m.id.slice(0, 8);

function line(m: Memory): string {
  return `  [${ref(m)}] ${m.content}${m.tags.length ? `  (${m.tags.join(", ")})` : ""}`;
}

// The prompt block. Returns lines rather than a string so callers can splice it into
// their own list, which is how fleetGuidance already works.
export async function memoryBlock(deviceId?: string): Promise<string[]> {
  const rows = await memoriesFor(deviceId ?? null);
  if (!rows.length) return [];

  const system = rows.filter((m) => !m.device_id).slice(0, SHOWN_PER_SCOPE);
  const device = rows.filter((m) => m.device_id).slice(0, SHOWN_PER_SCOPE);

  const out = ["", "What you remember from before. Take it as true unless what you can see now says otherwise:"];
  if (system.length) out.push("About the person, wherever they are:", ...system.map(line));
  if (device.length) out.push("About this device in particular:", ...device.map(line));
  return out;
}

// Shared, so the console and a device agent cannot drift apart on what remembering
// means — the same reason fleetGuidance exists.
export function memoryGuidance(): string[] {
  return [
    "- remember(fact, scope) keeps one thing worth knowing next time. Be sparing and be specific:",
    "  a preference, a name, a standing instruction, something true about the hardware.",
    "  Not what was just said, not anything you could look up again, and never a fact already listed",
    "  above — read that list first.",
    '- scope "device" is about this terminal. scope "system" is about the person and follows them',
    "  to every device. When in doubt it is a device memory.",
    "- forget(id) drops one, using the id in brackets above. Do it when you are told to, or when",
    "  something you remember has turned out to be wrong.",
  ];
}

// Resolved against what this caller can actually see, so a device cannot reach into
// another device's memories by guessing an id.
async function resolve(idRef: string, deviceId?: string): Promise<Memory> {
  const want = idRef.trim().toLowerCase();
  if (!want) throw new Error("give the id in brackets from the list");
  const hits = (await memoriesFor(deviceId ?? null)).filter((m) => m.id.startsWith(want));
  if (!hits.length) throw new Error(`nothing remembered starts with "${want}"`);
  if (hits.length > 1) throw new Error(`"${want}" matches ${hits.length} of them; use more of the id`);
  return hits[0];
}

export function memoryTools(opts: { self?: string; run?: RunHere } = {}): ToolSet {
  const { self, run } = opts;
  const here = (name: string, args: Record<string, unknown>, body: () => Promise<string>, risk: string) =>
    run ? run(name, args, body, risk) : body();

  return {
    remember: tool({
      description:
        "Keep one fact for future sessions. Use it for preferences, names, standing instructions and " +
        "facts about the hardware — things that will still matter in a month. Do not use it to log " +
        "the conversation, and check what you already remember before adding to it.",
      inputSchema: z.object({
        fact: z
          .string()
          .describe("one fact, in a sentence, written so it still makes sense with no conversation around it"),
        scope: z
          .enum(["device", "system"])
          .default("device")
          .describe('"device" for this terminal only, "system" for anything about the person'),
        tags: z.array(z.string().max(24)).max(8).optional().describe("a few lowercase words, for searching later"),
      }),
      execute: async ({ fact, scope, tags }) =>
        here(
          "remember",
          { fact, scope, tags },
          async () => {
            const content = fact.trim();
            if (!content) throw new Error("there is nothing to remember");
            if (content.length > MAX_CONTENT) throw new Error(`too long; keep it under ${MAX_CONTENT} characters`);
            // A device agent can only write its own device's scope. The console has no
            // device, so everything it writes is global whatever it asks for.
            const device_id = scope === "device" ? (self ?? null) : null;
            if (scope === "device" && !self) {
              throw new Error("there is no device here to attach that to; save it as scope \"system\" instead");
            }
            const saved = await createMemory({ content, tags: tags ?? [], device_id });
            return `remembered as [${ref(saved)}] (${device_id ? "this device" : "system"}): ${content}`;
          },
          "create",
        ),
    }),

    forget: tool({
      description:
        "Drop something you remember, by the id shown in brackets in the list of what you remember. " +
        "Use it when asked to forget something, or when a memory has turned out to be wrong.",
      inputSchema: z.object({
        id: z.string().describe("the id in brackets, e.g. 3f7a1c2b"),
      }),
      execute: async ({ id }) =>
        here(
          "forget",
          { id },
          async () => {
            const m = await resolve(id, self);
            await deleteMemory(m.id);
            return `forgotten: ${m.content}`;
          },
          "destructive",
        ),
    }),
  };
}
