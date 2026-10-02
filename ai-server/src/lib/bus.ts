import { EventEmitter } from "node:events";
import type { LiveMessage } from "./types";

// The gateway (loaded by server.ts) and Next route handlers are separate module
// graphs in the same process, so shared state hangs off globalThis.
const g = globalThis as { __aitermBus?: EventEmitter };
const bus = (g.__aitermBus ??= new EventEmitter().setMaxListeners(200));

export function publish(msg: LiveMessage) {
  bus.emit("live", msg);
}

export function subscribe(fn: (msg: LiveMessage) => void): () => void {
  bus.on("live", fn);
  return () => bus.off("live", fn);
}
