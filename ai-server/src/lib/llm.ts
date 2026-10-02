import { createAnthropic } from "@ai-sdk/anthropic";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createProviderRegistry, isStepCount, streamText, type ModelMessage, type ToolSet } from "ai";
import { env } from "./env";
import type { LlmSettings } from "./types";

export const PROVIDERS = [
  {
    id: "deepseek",
    label: "DeepSeek",
    envKey: "DEEPSEEK_API_KEY",
    models: ["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-flash"],
  },
  {
    id: "anthropic",
    label: "Anthropic",
    envKey: "ANTHROPIC_API_KEY",
    models: ["claude-sonnet-5", "claude-opus-5", "claude-haiku-4-5", "claude-fable-5-1"],
  },
  {
    id: "openai",
    label: "OpenAI",
    envKey: "OPENAI_API_KEY",
    models: ["gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano"],
  },
  {
    id: "google",
    label: "Google",
    envKey: "GOOGLE_GENERATIVE_AI_API_KEY",
    models: ["gemini-3.1-pro-preview", "gemini-2.5-flash", "gemini-3.1-flash-lite-preview"],
  },
] as const;

export type ProviderId = (typeof PROVIDERS)[number]["id"];

export function providerStatus() {
  const e = env();
  return PROVIDERS.map((p) => ({ ...p, configured: Boolean(e[p.envKey]) }));
}

let registry: ReturnType<typeof buildRegistry> | undefined;

function buildRegistry() {
  const e = env();
  return createProviderRegistry({
    deepseek: createDeepSeek({ apiKey: e.DEEPSEEK_API_KEY }),
    anthropic: createAnthropic({ apiKey: e.ANTHROPIC_API_KEY }),
    openai: createOpenAI({ apiKey: e.OPENAI_API_KEY }),
    google: createGoogleGenerativeAI({ apiKey: e.GOOGLE_GENERATIVE_AI_API_KEY }),
  });
}

export function languageModel(id: string) {
  registry ??= buildRegistry();
  const [provider] = id.split(":");
  const known = providerStatus().find((p) => p.id === provider);
  if (!known) throw new Error(`Unknown provider in model id "${id}" (expected provider:model)`);
  if (!known.configured) throw new Error(`${known.envKey} is not set`);
  return registry.languageModel(id as `${ProviderId}:${string}`);
}

export function streamChat(
  settings: LlmSettings,
  messages: ModelMessage[],
  abortSignal?: AbortSignal,
  extra: { tools?: ToolSet; maxSteps?: number; instructionsSuffix?: string; onError?: (error: unknown) => void } = {},
) {
  return streamText({
    model: languageModel(settings.model),
    instructions: extra.instructionsSuffix ? `${settings.systemPrompt}\n\n${extra.instructionsSuffix}` : settings.systemPrompt,
    messages,
    maxOutputTokens: settings.maxOutputTokens,
    ...(settings.temperature != null ? { temperature: settings.temperature } : {}),
    ...(extra.tools ? { tools: extra.tools, stopWhen: isStepCount(extra.maxSteps ?? 12) } : {}),
    ...(extra.onError ? { onError: ({ error }: { error: unknown }) => extra.onError?.(error) } : {}),
    abortSignal,
  });
}
