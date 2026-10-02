import type { Metadata } from "next";
import { LinkDown, load } from "@/components/term/link-down";
import { listDevices } from "@/lib/db/devices";
import { listMemories } from "@/lib/db/memories";
import { MemoryBank } from "./memory-bank";

export const metadata: Metadata = { title: "memories" };

export default async function MemoriesPage() {
  const res = await load(() => Promise.all([listMemories(), listDevices()]));
  if (!res.ok) return <LinkDown error={res.error} />;
  return <MemoryBank memories={res.data[0]} devices={res.data[1].map((d) => ({ id: d.id, name: d.name }))} />;
}
