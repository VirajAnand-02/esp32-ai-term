"use client";

import { usePathname } from "next/navigation";
import { Tabs } from "@/components/term/tabs";

const TABS = [
  { id: "llm", label: "llm", href: "/settings/llm" },
  { id: "devices", label: "devices", href: "/settings/devices" },
  { id: "memories", label: "memories", href: "/settings/memories" },
  { id: "calendar", label: "calendar", href: "/settings/calendar" },
  { id: "databases", label: "databases", href: "/settings/databases" },
];

export function SettingsTabs() {
  const pathname = usePathname();
  const active = TABS.find((t) => pathname.startsWith(t.href))?.id ?? "llm";
  return <Tabs tabs={TABS} active={active} />;
}
