"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { checkCredentials, clearLoginFailures, loginBlockedFor, recordLoginFailure } from "@/lib/auth";
import { createSessionToken, SESSION_COOKIE, SESSION_MAX_AGE } from "@/lib/session";

export type LoginState = { error?: string; attempt?: number };

export async function login(prev: LoginState, form: FormData): Promise<LoginState> {
  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  const attempt = (prev.attempt ?? 0) + 1;

  const wait = loginBlockedFor(ip);
  if (wait) return { error: `too many attempts. retry in ${wait}s`, attempt };

  const username = String(form.get("username") ?? "");
  const password = String(form.get("password") ?? "");
  let ok = false;
  try {
    ok = checkCredentials(username, password);
  } catch (err) {
    return { error: (err as Error).message.split("\n")[0], attempt };
  }
  if (!ok) {
    recordLoginFailure(ip);
    return { error: "access denied", attempt };
  }

  clearLoginFailures(ip);
  const store = await cookies();
  store.set(SESSION_COOKIE, await createSessionToken(username), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_MAX_AGE,
  });

  const next = String(form.get("next") ?? "/");
  redirect(next.startsWith("/") && !next.startsWith("//") ? next : "/");
}

export async function logout() {
  (await cookies()).delete(SESSION_COOKIE);
  redirect("/login");
}
