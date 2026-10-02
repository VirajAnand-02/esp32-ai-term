import type { Metadata } from "next";
import { LinkDown, load } from "@/components/term/link-down";
import { ButtonLink, PageHeader } from "@/components/term/primitives";
import { peerInfoFor } from "@/lib/db/agents";
import { listDevices } from "@/lib/db/devices";
import { DeviceCards } from "./device-cards";

export const metadata: Metadata = { title: "devices" };

export default async function DevicesPage() {
  const res = await load(listDevices);
  const peers = res.ok ? await peerInfoFor(res.data) : {};
  return (
    <>
      <PageHeader
        title="devices"
        subtitle="every client that can talk to this server: ESP32 terminals, CLIs, the web console, attached agents"
        actions={
          <ButtonLink href="/settings/devices" variant="primary">
            + add device
          </ButtonLink>
        }
      />
      {!res.ok ? <LinkDown error={res.error} /> : <DeviceCards initial={res.data} peers={peers} />}
    </>
  );
}
