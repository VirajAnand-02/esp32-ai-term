import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { LinkDown, load } from "@/components/term/link-down";
import { getPeer } from "@/lib/db/agents";
import { getDevice } from "@/lib/db/devices";
import { listEvents } from "@/lib/db/events";
import { listSessions } from "@/lib/db/sessions";
import { peerReachable, probePeer } from "@/lib/peers";
import { DeviceDetail } from "./device-detail";
import type { PeerView } from "./peer-panel";

export const metadata: Metadata = { title: "device" };

export default async function DevicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();

  const res = await load(() => Promise.all([getDevice(id), listEvents({ deviceId: id, limit: 150 }), listSessions(id)]));
  if (!res.ok) return <LinkDown error={res.error} />;
  const [device, events, sessions] = res.data;
  if (!device) notFound();

  // The key is read on the server and stays there: whether one is set is all the page
  // needs to render, and all it is told.
  let peer: PeerView = null;
  if (device.kind === "agent") {
    const row = await getPeer(id).catch(() => null);
    if (row) {
      // One device, opened deliberately, so a real probe is affordable here -- unlike the
      // roster, which runs on every turn. Only on a cold cache: the reading is good for
      // five minutes, and the endpoint tab's Test button forces a fresh one.
      let reach = peerReachable(id);
      if (reach === "unknown") {
        const probe = await probePeer(row).catch(() => null);
        if (probe) reach = probe.reachable && probe.accepted ? "yes" : "no";
      }
      peer = { baseUrl: row.base_url, model: row.model ?? "", timeoutS: row.timeout_s, hasKey: Boolean(row.api_key), reach };
    }
  }

  return <DeviceDetail device={device} events={events} sessions={sessions} peer={peer} />;
}
