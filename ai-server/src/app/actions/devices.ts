"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { createDevice, deleteDevice, rotateDeviceToken, updateDevice } from "@/lib/db/devices";
import { logEvent } from "@/lib/db/events";
import { live } from "@/lib/live";
import { DEVICE_KINDS } from "@/lib/types";

// Server actions are public endpoints, so each one re-checks the session.

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

function fail(err: unknown): { ok: false; error: string } {
  return { ok: false, error: err instanceof z.ZodError ? (err.issues[0]?.message ?? "invalid input") : (err as Error).message };
}

const deviceInput = z.object({
  name: z.string().trim().min(1, "name is required").max(48),
  kind: z.enum(DEVICE_KINDS),
  hostname: z.string().trim().max(64).optional().transform((v) => v || null),
});

export async function addDevice(input: z.input<typeof deviceInput>): Promise<Result<{ id: string; token: string }>> {
  await requireAdmin();
  try {
    const { device, token } = await createDevice(deviceInput.parse(input));
    await logEvent({ device_id: device.id, type: "action", summary: `device registered (${device.kind})` });
    revalidatePath("/", "layout");
    return { ok: true, id: device.id, token };
  } catch (err) {
    return fail(err);
  }
}

export async function renameDevice(id: string, name: string): Promise<Result> {
  await requireAdmin();
  try {
    await updateDevice(id, { name: z.string().trim().min(1).max(48).parse(name) });
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

export async function rotateToken(id: string): Promise<Result<{ token: string }>> {
  await requireAdmin();
  try {
    const token = await rotateDeviceToken(id);
    live.kick(id, "token rotated");
    await logEvent({ device_id: id, type: "action", level: "warn", summary: "token rotated, active session closed" });
    return { ok: true, token };
  } catch (err) {
    return fail(err);
  }
}

export async function removeDevice(id: string): Promise<Result> {
  await requireAdmin();
  try {
    live.kick(id, "device removed");
    await deleteDevice(id);
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

export async function disconnectDevice(id: string): Promise<Result<{ wasOnline: boolean }>> {
  await requireAdmin();
  return { ok: true, wasOnline: live.kick(id) };
}

export async function saveDeviceConfig(id: string, json: string): Promise<Result<{ pushed: boolean }>> {
  await requireAdmin();
  try {
    let config: unknown;
    try {
      config = JSON.parse(json);
    } catch {
      return { ok: false, error: "config is not valid JSON" };
    }
    const parsed = z.record(z.string(), z.unknown()).parse(config);
    await updateDevice(id, { config: parsed });
    const pushed = live.send(id, { type: "config", config: parsed });
    await logEvent({ device_id: id, type: "action", summary: `config updated${pushed ? " and pushed" : ""}` });
    revalidatePath(`/devices/${id}`);
    return { ok: true, pushed };
  } catch (err) {
    return fail(err);
  }
}
