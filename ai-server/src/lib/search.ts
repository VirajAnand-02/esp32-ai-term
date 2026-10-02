import { env } from "./env";

// Web search through Tavily. The point is not general knowledge — the model has plenty
// of that — it is *urls*. Asked for a YouTube link it will otherwise write a
// well-formed, entirely invented video id, and yt-dlp fails on it a minute later.
// Search results are links that actually exist.

const ENDPOINT = "https://api.tavily.com/search";
const RESULTS = 5;
const SNIPPET = 300; // Tavily's own extracts run past a thousand characters
const TIMEOUT_MS = 15_000;

export type SearchHit = { title: string; url: string; snippet: string };

export function searchAvailable(): boolean {
  return Boolean(env().TAVILY_API_KEY);
}

// Takes whatever the model is likely to write — "youtube.com", "www.youtube.com",
// "https://youtube.com/watch" — and reduces it to the bare host Tavily wants.
function domain(site: string): string {
  return site
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "");
}

// Tavily hands back raw page text, so the extracts carry whatever the page had —
// control characters, emoji, flags. Cap by code point, not by `slice`: cutting a
// surrogate pair in half leaves a lone surrogate, which is legal in a JS string but not
// in JSON, and PostgREST throws out the entire request with "Empty or invalid json"
// when the tool call is saved. One flag emoji in a YouTube title was enough to lose a
// whole search result from the session.
function squash(text: string): string {
  const clean = text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  const chars = [...clean];
  return chars.length <= SNIPPET ? clean : `${chars.slice(0, SNIPPET).join("")}…`;
}

export async function webSearch(
  query: string,
  opts: { site?: string; maxResults?: number } = {},
): Promise<SearchHit[]> {
  const key = env().TAVILY_API_KEY;
  if (!key) throw new Error("TAVILY_API_KEY is not set, so web search is off");
  const site = opts.site ? domain(opts.site) : "";

  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      query,
      max_results: opts.maxResults ?? RESULTS,
      search_depth: "basic",
      // No generated answer and no raw page text: both cost time, and a device that can
      // only show two short lines needs the links, not more prose to summarise.
      include_answer: false,
      include_raw_content: false,
      ...(site ? { include_domains: [site] } : {}),
    }),
    // fetch has no timeout of its own, and nothing above this caps a server-side tool.
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`tavily ${res.status}: ${detail.slice(0, 300) || res.statusText}`);
  }

  const data = (await res.json()) as { results?: { title?: string; url?: string; content?: string }[] };
  return (data.results ?? [])
    .filter((r): r is { title?: string; url: string; content?: string } => Boolean(r.url))
    .map((r) => ({ title: (r.title ?? "").trim(), url: r.url, snippet: squash(r.content ?? "") }));
}
