import { live } from "@/lib/live";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const link = live.link(id);
  if (!link?.run) return Response.json({ error: "nothing is running" }, { status: 409 });
  link.run.abort.abort();
  return Response.json({ ok: true });
}
