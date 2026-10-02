import sharp from "sharp";

// Getting a picture onto a 240x240 panel. The ESP32 can neither fetch nor rescale
// an image, so all of that happens here and the device receives a JPEG it can hand
// straight to its decoder.

const OPENVERSE = "https://api.openverse.org/v1/images/";
const FETCH_TIMEOUT_MS = 12_000;
const MAX_SOURCE_BYTES = 12 * 1024 * 1024;

export type Found = { url: string; title?: string; creator?: string; source?: string };
export type Fitted = { jpeg: Buffer; width: number; height: number; from: string; credit?: string };

async function get(url: string, accept: string): Promise<Response> {
  const res = await fetch(url, {
    headers: { Accept: accept, "User-Agent": "ai-term/0.2 (esp32 terminal)" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res;
}

// Openverse indexes openly licensed images and needs no API key, which keeps this
// working without another secret to manage.
export async function searchImage(query: string): Promise<Found | null> {
  const url = `${OPENVERSE}?q=${encodeURIComponent(query)}&page_size=8&mature=false`;
  const data = (await get(url, "application/json").then((r) => r.json())) as {
    results?: { url?: string; thumbnail?: string; title?: string; creator?: string; source?: string }[];
  };

  for (const hit of data.results ?? []) {
    // The thumbnail is already downscaled, so prefer it: less to download and it is
    // nearer the size actually wanted.
    const url = hit.thumbnail ?? hit.url;
    if (url) return { url, title: hit.title, creator: hit.creator, source: hit.source };
  }
  return null;
}

async function download(url: string): Promise<Buffer> {
  // Some proxies answer 406 to a narrow Accept, so ask for anything.
  const res = await get(url, "image/*,*/*;q=0.8");
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > MAX_SOURCE_BYTES) throw new Error("that image is too large to fetch");
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > MAX_SOURCE_BYTES) throw new Error("that image is too large to fetch");
  return buf;
}

// `cover` fills the panel and crops, picking the crop by where the detail is, which
// is almost always what you want for a photo. `contain` keeps the whole frame and
// letterboxes it, which suits diagrams and text.
export async function fitForPanel(source: Buffer, size: number, fit: "cover" | "contain"): Promise<Buffer> {
  return sharp(source, { failOn: "none", animated: false })
    .rotate() // honour the EXIF orientation before cropping
    .resize(size, size, {
      fit,
      position: fit === "cover" ? sharp.strategy.attention : "centre",
      background: { r: 0, g: 0, b: 0 },
    })
    .flatten({ background: { r: 0, g: 0, b: 0 } }) // the panel has no alpha
    // Baseline, never progressive: the decoder on the device is TJpgDec, which only
    // handles baseline JPEG and silently refuses anything else. sharp's mozjpeg preset
    // turns on optimiseScans, which makes it progressive, so it stays off.
    .jpeg({ quality: 82, progressive: false, optimiseCoding: true, chromaSubsampling: "4:2:0" })
    .toBuffer();
}

export async function imageForPanel(opts: {
  url?: string;
  query?: string;
  fit?: "cover" | "contain";
  size?: number;
}): Promise<Fitted> {
  const size = opts.size ?? 240;
  const fit = opts.fit ?? "cover";

  let url = opts.url;
  let credit: string | undefined;
  if (!url) {
    if (!opts.query) throw new Error("give either a url or something to search for");
    const found = await searchImage(opts.query);
    if (!found) throw new Error(`nothing found for "${opts.query}"`);
    url = found.url;
    credit = [found.title, found.creator && `by ${found.creator}`, found.source].filter(Boolean).join(" ");
  }

  const jpeg = await fitForPanel(await download(url), size, fit);
  return { jpeg, width: size, height: size, from: url, credit };
}
