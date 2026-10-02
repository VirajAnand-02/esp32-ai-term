"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { deletePeer, getPeer, savePeer } from "@/lib/db/agents";
import { getDevice } from "@/lib/db/devices";
import { logEvent } from "@/lib/db/events";

// Server actions are public endpoints, so each one re-checks the session.

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

function fail(err: unknown): { ok: false; error: string } {
  return { ok: false, error: err instanceof z.ZodError ? (err.issues[0]?.message ?? "invalid input") : (err as Error).message };
}

const peer = z.object({
  baseUrl: z
    .string()
    .trim()
    .max(500)
    .refine((v) => /^https?:\/\//.test(v), "the base url has to start with http:// or https://"),
  // Blank keeps whatever is stored, so the form never has to echo the key back to be
  // able to change the model next to it.
  apiKey: z.string().trim().max(500).optional(),
  model: z.string().trim().max(120).optional(),
  timeoutS: z.number().int().min(10).max(3600),
});

async function mustBeAgent(deviceId: string) {
  const device = await getDevice(deviceId);
  if (!device) throw new Error("no such device");
  if (device.kind !== "agent") throw new Error("that device is not an attached agent");
  return device;
}

export async function savePeerConfig(deviceId: string, input: z.input<typeof peer>): Promise<Result> {
  await requireAdmin();
  try {
    await mustBeAgent(deviceId);
    const v = peer.parse(input);
    const existing = await getPeer(deviceId);
    await savePeer({
      device_id: deviceId,
      base_url: v.baseUrl,
      // An empty box means "leave the key alone", not "clear it" — clearing is what the
      // remove button is for.
      api_key: v.apiKey ? v.apiKey : (existing?.api_key ?? null),
      model: v.model || null,
      timeout_s: v.timeoutS,
    });
    // A changed url or key makes the cached health reading meaningless, and the roster
    // would otherwise keep quoting it for up to five minutes.
    const { forgetHealth } = await import("@/lib/peers");
    forgetHealth(deviceId);
    // The url is in the summary; the key is not, and must not be.
    await logEvent({ device_id: deviceId, type: "action", summary: `agent endpoint set: ${host(v.baseUrl)}` });
    revalidatePath(`/devices/${deviceId}`);
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

export async function removePeerConfig(deviceId: string): Promise<Result> {
  await requireAdmin();
  try {
    await deletePeer(deviceId);
    const { forgetHealth } = await import("@/lib/peers");
    forgetHealth(deviceId);
    await logEvent({ device_id: deviceId, type: "action", level: "warn", summary: "agent endpoint removed" });
    revalidatePath(`/devices/${deviceId}`);
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

// Asks the harness for its model list, which is the cheapest thing that proves the
// whole path: the host resolves, it is listening, and the key is accepted.
export async function testPeer(deviceId: string): Promise<Result<{ detail: string }>> {
  await requireAdmin();
  try {
    await mustBeAgent(deviceId);
    const row = await getPeer(deviceId);
    if (!row) return { ok: false, error: "no base url saved yet" };
    const { probePeer } = await import("@/lib/peers");
    const probe = await probePeer(row);
    if (!probe.reachable) {
      return {
        ok: false,
        error: `${host(row.base_url)}: ${probe.detail}. Check the harness is running, its API server is enabled, and the host is reachable from this machine.`,
      };
    }
    if (!probe.accepted) return { ok: false, error: `${host(row.base_url)} ${probe.detail}` };
    return { ok: true, detail: `${host(row.base_url)} ${probe.detail}` };
  } catch (err) {
    return fail(err);
  }
}

function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
