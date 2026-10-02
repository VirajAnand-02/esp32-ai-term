import { subscribe } from "@/lib/bus";

export const dynamic = "force-dynamic";

// Server-sent events: every gateway event and presence change, as it happens.
export function GET(req: Request) {
  const encoder = new TextEncoder();
  let cleanup = () => {};

  const stream = new ReadableStream({
    start(controller) {
      const write = (s: string) => {
        try {
          controller.enqueue(encoder.encode(s));
        } catch {
          cleanup();
        }
      };
      write("retry: 3000\n\n");
      const unsubscribe = subscribe((msg) => write(`data: ${JSON.stringify(msg)}\n\n`));
      const ping = setInterval(() => write(": ping\n\n"), 15_000);
      cleanup = () => {
        unsubscribe();
        clearInterval(ping);
      };
      req.signal.addEventListener("abort", () => {
        cleanup();
        try {
          controller.close();
        } catch {}
      });
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
