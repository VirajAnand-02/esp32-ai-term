import type { Reachable } from "./peers";
import type { Device } from "./types";

// How a fleet row is shown, in one place because three views got it wrong separately.
//
// An attached agent has no presence: nothing connects to us, we call it. So its `status`
// column is permanently "offline", and a view that renders `status` dressed a working
// peer as a fault. Reachability replaces presence for one, and "unchecked" is a real
// third state rather than a quiet "no" -- the probe is cached and may not have run yet.
//
// Pure, so client components can import it. The loader is `peerInfoFor` in db/agents.ts.

export type PeerInfo = { host: string; reach: Reachable; model: string | null };

export type FleetState = {
  label: string;
  /** Worth lighting up: connected, or an agent we know answers. */
  live: boolean;
  tone: "phos" | "amber" | "err";
};

export function fleetState(device: Device, peer?: PeerInfo): FleetState {
  if (device.kind !== "agent") {
    const on = device.status === "online";
    return { label: device.status, live: on, tone: on ? "phos" : "amber" };
  }
  if (!peer) return { label: "no endpoint", live: false, tone: "err" };
  if (peer.reach === "yes") return { label: "reachable", live: true, tone: "phos" };
  if (peer.reach === "no") return { label: "unreachable", live: false, tone: "err" };
  return { label: "unchecked", live: false, tone: "amber" };
}

/** "up" / "down" / neither, for the list filters and the counts beside them. */
export function fleetBucket(device: Device, peer?: PeerInfo): "up" | "down" | "none" {
  const state = fleetState(device, peer);
  if (state.live) return "up";
  return state.label === "unchecked" ? "none" : "down";
}
