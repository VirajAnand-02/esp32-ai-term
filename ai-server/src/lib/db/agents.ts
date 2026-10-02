import type { PeerInfo } from "../fleet-view";
import { peerHost, peerReachable, refreshStale } from "../peers";
import { db, must } from "../supabase";
import type { AgentPeer, Device } from "../types";

// Where an attached agent harness lives. One row per device of kind "agent".
//
// Kept out of `devices.config` deliberately: the key is sent to the harness, so it
// cannot be hashed like `token_hash`, and `config` is part of every device read the
// dashboard makes. Nothing here is ever selected by `listDevices`.

const COLUMNS = "device_id, base_url, api_key, model, timeout_s";

export async function getPeer(deviceId: string): Promise<AgentPeer | null> {
  return must(await db().from("agent_peers").select(COLUMNS).eq("device_id", deviceId).maybeSingle());
}

export async function listPeers(): Promise<AgentPeer[]> {
  return must(await db().from("agent_peers").select(COLUMNS));
}

export async function savePeer(input: AgentPeer): Promise<void> {
  must(
    await db()
      .from("agent_peers")
      .upsert({ ...input, updated_at: new Date().toISOString() })
      .select("device_id")
      .single(),
  );
}

export async function deletePeer(deviceId: string): Promise<void> {
  must(await db().from("agent_peers").delete().eq("device_id", deviceId).select("device_id").maybeSingle());
}

/**
 * What the dashboard needs to show the kind-"agent" rows, keyed by device id.
 *
 * Reachability comes from the cache only: `peerReachable` never does I/O, for the reason
 * in lib/peers.ts, so a cold cache reads "unchecked" and `refreshStale` fills it for the
 * next render instead of making a page wait on a probe per agent. Returns {} when the
 * fleet has no agents, so the common case costs nothing.
 */
export async function peerInfoFor(devices: Device[]): Promise<Record<string, PeerInfo>> {
  if (!devices.some((d) => d.kind === "agent")) return {};
  const peers = await listPeers().catch(() => []);
  refreshStale(peers);
  return Object.fromEntries(
    peers.map((p) => [p.device_id, { host: peerHost(p.base_url), reach: peerReachable(p.device_id), model: p.model }]),
  );
}
