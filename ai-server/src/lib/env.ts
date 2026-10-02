import { z } from "zod";

// Admin credentials and SESSION_SECRET are read directly by auth.ts / session.ts,
// so the gateway and scripts don't need them.
const schema = z.object({
  APP_URL: z.string().default("http://localhost:3000"),
  SUPABASE_URL: z.url("SUPABASE_URL is not set"),
  SUPABASE_SECRET_KEY: z.string().min(1, "SUPABASE_SECRET_KEY is not set"),
  DEEPSEEK_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  GOOGLE_GENERATIVE_AI_API_KEY: z.string().optional(),
  GROQ_API_KEY: z.string().optional(),
  TRANSCRIBE_MODEL: z.string().default("whisper-large-v3-turbo"),
  TAVILY_API_KEY: z.string().optional(),
  DEFAULT_MODEL: z.string().default("deepseek:deepseek-v4-flash"),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

// Parsed lazily so `next build` works without runtime secrets.
export function env(): Env {
  if (!cached) {
    const blanksRemoved = Object.fromEntries(
      Object.entries(process.env).filter(([, v]) => v !== ""),
    );
    const parsed = schema.safeParse(blanksRemoved);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
      throw new Error(`Invalid environment:\n${issues}`);
    }
    cached = parsed.data;
  }
  return cached;
}
