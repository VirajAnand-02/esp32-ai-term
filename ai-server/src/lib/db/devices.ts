import { createHash, randomBytes } from "node:crypto";
import { db, must } from "../supabase";
import type { Device, DeviceKind } from "../types";

const COLUMNS = "id, name, kind, hostname, firmware, hw, ip, status, last_seen_at, config, created_at";

export function newDeviceToken() {
  return `at_${randomBytes(24).toString("base64url")}`;
}

export function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export async function listDevices(): Promise<Device[]> {
  return must(await db().from("devices").select(COLUMNS).order("created_at"));
}

export async function getDevice(id: string): Promise<Device | null> {
  const res = await db().from("devices").select(COLUMNS).eq("id", id).maybeSingle();
  return must(res);
}

export async function findDeviceByToken(token: string): Promise<Device | null> {
  const res = await db().from("devices").select(COLUMNS).eq("token_hash", hashToken(token)).maybeSingle();
  return must(res);
}

export async function createDevice(input: { name: string; kind: DeviceKind; hostname?: string | null }) {
  const token = newDeviceToken();
  const device: Device = must(
    await db()
      .from("devices")
      .insert({ ...input, token_hash: hashToken(token) })
      .select(COLUMNS)
      .single(),
  );
  return { device, token };
}

export async function rotateDeviceToken(id: string) {
  const token = newDeviceToken();
  must(await db().from("devices").update({ token_hash: hashToken(token) }).eq("id", id).select("id").single());
  return token;
}

export async function updateDevice(id: string, patch: Partial<Omit<Device, "id" | "created_at">>) {
  must(await db().from("devices").update(patch).eq("id", id).select("id").single());
}

export async function deleteDevice(id: string) {
  must(await db().from("devices").delete().eq("id", id).select("id"));
}

// The browser console shows up as a "web" device so its chats are logged like any other client.
export async function ensureWebConsoleDevice(): Promise<Device> {
  const existing = must(
    await db().from("devices").select(COLUMNS).eq("kind", "web").eq("hostname", "dashboard").limit(1),
  ) as Device[];
  if (existing[0]) return existing[0];
  return must(
    await db()
      .from("devices")
      .insert({ name: "Web console", kind: "web", hostname: "dashboard" })
      .select(COLUMNS)
      .single(),
  );
}

// Anything still marked online from a previous process is stale.
export async function markAllOffline() {
  must(await db().from("devices").update({ status: "offline" }).eq("status", "online").select("id"));
}
