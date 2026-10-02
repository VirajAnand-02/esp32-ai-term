import type { Metadata } from "next";
import { LoginTerminal } from "./login-terminal";

export const metadata: Metadata = { title: "login" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-10">
      <LoginTerminal next={next ?? "/"} />
    </main>
  );
}
