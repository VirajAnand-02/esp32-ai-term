import { Shell } from "@/components/shell/shell";
import { requireAdmin } from "@/lib/auth";
import { peerInfoFor } from "@/lib/db/agents";
import { listDevices } from "@/lib/db/devices";
import { fleetState, type PeerInfo } from "@/lib/fleet-view";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireAdmin();
  const devices = await listDevices().catch(() => []);
  // An attached agent counts as a node like any other, but "up" means reachable rather
  // than connected -- so the state comes from fleetState, not from `status`.
  const peers = await peerInfoFor(devices).catch((): Record<string, PeerInfo> => ({}));
  const rows = devices.map((d) => {
    const state = fleetState(d, peers[d.id]);
    return { id: d.id, name: d.name, online: state.live, agent: d.kind === "agent", label: state.label, tone: state.tone };
  });
  return (
    <Shell user={user} devices={rows}>
      {children}
    </Shell>
  );
}
