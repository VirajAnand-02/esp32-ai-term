import type { Metadata } from "next";
import { headers } from "next/headers";
import { LinkDown, load } from "@/components/term/link-down";
import { listDevices } from "@/lib/db/devices";
import { DeviceManager } from "./device-manager";

export const metadata: Metadata = { title: "device settings" };

export default async function DeviceSettingsPage() {
  const res = await load(listDevices);
  if (!res.ok) return <LinkDown error={res.error} />;

  // The URL a device should use, based on how this page was reached.
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const wsUrl = `${proto === "https" ? "wss" : "ws"}://${host}/ws`;

  return <DeviceManager devices={res.data} wsUrl={wsUrl} />;
}
