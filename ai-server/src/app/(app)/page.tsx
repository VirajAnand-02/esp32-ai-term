import { LinkDown, load } from "@/components/term/link-down";
import { PageHeader } from "@/components/term/primitives";
import { peerInfoFor } from "@/lib/db/agents";
import { listDevices } from "@/lib/db/devices";
import { listEvents } from "@/lib/db/events";
import { getDashboardStats } from "@/lib/db/stats";
import { Dashboard } from "./dashboard";

export default async function DashboardPage() {
  const res = await load(() => Promise.all([getDashboardStats(), listEvents({ limit: 40 }), listDevices()]));
  const peers = res.ok ? await peerInfoFor(res.data[2]) : {};
  return (
    <>
      <PageHeader title="dashboard" subtitle="fleet status, activity and live traffic" />
      {!res.ok ? <LinkDown error={res.error} /> : <Dashboard stats={res.data[0]} events={res.data[1]} devices={res.data[2]} peers={peers} />}
    </>
  );
}
