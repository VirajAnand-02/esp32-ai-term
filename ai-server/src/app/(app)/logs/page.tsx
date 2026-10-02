import type { Metadata } from "next";
import { LinkDown, load } from "@/components/term/link-down";
import { PageHeader } from "@/components/term/primitives";
import { listDevices } from "@/lib/db/devices";
import { listEvents } from "@/lib/db/events";
import { LogExplorer } from "./log-explorer";

export const metadata: Metadata = { title: "logs" };

export default async function LogsPage({ searchParams }: { searchParams: Promise<{ device?: string }> }) {
  const { device } = await searchParams;
  const deviceId = device && /^[0-9a-f-]{36}$/i.test(device) ? device : undefined;
  const res = await load(() => Promise.all([listEvents({ deviceId, limit: 200 }), listDevices()]));

  return (
    <>
      <PageHeader title="logs" subtitle="every command, chat, action and error across all devices" />
      {!res.ok ? (
        <LinkDown error={res.error} />
      ) : (
        <LogExplorer key={deviceId ?? "all"} initial={res.data[0]} devices={res.data[1]} initialDevice={deviceId} />
      )}
    </>
  );
}
