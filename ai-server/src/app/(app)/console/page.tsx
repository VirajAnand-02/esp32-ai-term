import type { Metadata } from "next";
import { LinkDown, load } from "@/components/term/link-down";
import { PageHeader } from "@/components/term/primitives";
import { getLlmSettings } from "@/lib/db/settings";
import { providerStatus } from "@/lib/llm";
import { ChatConsole } from "./chat-console";

export const metadata: Metadata = { title: "console" };

export default async function ConsolePage() {
  const res = await load(async () => ({ settings: await getLlmSettings(), providers: providerStatus() }));
  if (!res.ok) return <LinkDown error={res.error} />;
  const { settings, providers } = res.data;
  const provider = providers.find((p) => settings.model.startsWith(`${p.id}:`));

  return (
    <>
      <PageHeader title="master console" subtitle="the master agent: sees every device, and can command any online one within its own access level" />
      <ChatConsole model={settings.model} ready={Boolean(provider?.configured)} missingKey={provider?.envKey} />
    </>
  );
}
