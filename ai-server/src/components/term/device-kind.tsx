import { Bot, Cpu, Globe, SquareTerminal, CircuitBoard } from "lucide-react";
import type { DeviceKind } from "@/lib/types";

const ICONS = { esp32: Cpu, web: Globe, cli: SquareTerminal, other: CircuitBoard, agent: Bot } as const;

export function DeviceKindIcon({ kind, className }: { kind: DeviceKind; className?: string }) {
  const Icon = ICONS[kind] ?? CircuitBoard;
  return <Icon className={className} size={16} strokeWidth={1.5} aria-label={kind} />;
}
