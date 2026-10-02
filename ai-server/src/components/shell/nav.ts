import { Gauge, MessageSquareCode, Cpu, ScrollText, SlidersHorizontal } from "lucide-react";

export const NAV = [
  { href: "/", label: "dashboard", key: "h", icon: Gauge },
  { href: "/devices", label: "devices", key: "d", icon: Cpu },
  { href: "/logs", label: "logs", key: "l", icon: ScrollText },
  { href: "/console", label: "console", key: "c", icon: MessageSquareCode },
  { href: "/settings", label: "settings", key: "s", icon: SlidersHorizontal },
] as const;

export function isActive(pathname: string, href: string) {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}
