"use client";

import { useEffect, useRef, useState } from "react";
import type { LiveMessage } from "@/lib/types";

type Listener = (msg: LiveMessage) => void;

// One EventSource per tab, shared by every component that listens.
const listeners = new Set<Listener>();
const statusListeners = new Set<(s: boolean) => void>();
let source: EventSource | undefined;
let connected = false;

function ensureSource() {
  if (source || typeof window === "undefined") return;
  source = new EventSource("/api/stream");
  source.onopen = () => {
    connected = true;
    statusListeners.forEach((l) => l(true));
  };
  source.onerror = () => {
    connected = false;
    statusListeners.forEach((l) => l(false));
  };
  source.onmessage = (e) => {
    const msg = JSON.parse(e.data) as LiveMessage;
    listeners.forEach((l) => l(msg));
  };
}

function maybeClose() {
  if (!listeners.size && !statusListeners.size && source) {
    source.close();
    source = undefined;
    connected = false;
  }
}

export function useLive(fn: Listener) {
  const ref = useRef(fn);
  useEffect(() => {
    ref.current = fn;
  });
  useEffect(() => {
    const l: Listener = (m) => ref.current(m);
    listeners.add(l);
    ensureSource();
    return () => {
      listeners.delete(l);
      maybeClose();
    };
  }, []);
}

export function useLiveStatus() {
  const [ok, setOk] = useState(false);
  useEffect(() => {
    statusListeners.add(setOk);
    ensureSource();
    queueMicrotask(() => setOk(connected));
    return () => {
      statusListeners.delete(setOk);
      maybeClose();
    };
  }, []);
  return ok;
}
