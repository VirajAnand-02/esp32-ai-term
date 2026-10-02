import type { Metadata } from "next";
import { LinkDown, load } from "@/components/term/link-down";
import { DEFAULT_SYSTEM_PROMPT, getLlmSettings } from "@/lib/db/settings";
import { providerStatus } from "@/lib/llm";
import { LlmForm } from "./llm-form";

export const metadata: Metadata = { title: "llm settings" };

export default async function LlmSettingsPage() {
  const res = await load(async () => ({ settings: await getLlmSettings(), providers: providerStatus() }));
  if (!res.ok) return <LinkDown error={res.error} />;
  const providers = res.data.providers.map(({ id, label, envKey, models, configured }) => ({ id, label, envKey, models: [...models], configured }));
  return <LlmForm initial={res.data.settings} providers={providers} defaultPrompt={DEFAULT_SYSTEM_PROMPT} />;
}
