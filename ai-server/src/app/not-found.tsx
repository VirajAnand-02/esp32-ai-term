import Link from "next/link";

export default function NotFound() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-3 px-4 text-center">
      <p className="font-display text-8xl leading-none text-amber glow">404</p>
      <p className="text-sm text-err glow-err">!! segmentation fault: address not mapped</p>
      <p className="text-xs text-muted">the route you asked for doesn&apos;t exist on this server.</p>
      <Link href="/" className="mt-3 border border-amber px-3 py-1.5 text-xs uppercase tracking-[0.2em] text-amber transition-all hover:bg-amber hover:text-bg">
        [ return to dashboard ]
      </Link>
    </main>
  );
}
