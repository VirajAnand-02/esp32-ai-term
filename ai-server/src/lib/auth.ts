import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, verifySessionToken } from "./session";

function digest(s: string) {
  return createHash("sha256").update(s).digest();
}

// Reads only the admin vars, so you can log in before Supabase is configured.
export function checkCredentials(username: string, password: string) {
  const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin";
  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
  if (!ADMIN_PASSWORD) throw new Error("ADMIN_PASSWORD is not set in the environment");
  // Hash first so both sides are the same length for timingSafeEqual.
  const userOk = timingSafeEqual(digest(username), digest(ADMIN_USERNAME));
  const passOk = timingSafeEqual(digest(password), digest(ADMIN_PASSWORD));
  return userOk && passOk;
}

// Simple in-memory limiter: 5 failures per 5 minutes per IP.
const failures = new Map<string, { count: number; until: number }>();
const WINDOW_MS = 5 * 60 * 1000;
const MAX_FAILURES = 5;

export function loginBlockedFor(ip: string): number {
  const f = failures.get(ip);
  if (!f || f.until < Date.now()) return 0;
  return f.count >= MAX_FAILURES ? Math.ceil((f.until - Date.now()) / 1000) : 0;
}

export function recordLoginFailure(ip: string) {
  const f = failures.get(ip);
  if (!f || f.until < Date.now()) failures.set(ip, { count: 1, until: Date.now() + WINDOW_MS });
  else f.count++;
}

export function clearLoginFailures(ip: string) {
  failures.delete(ip);
}

export async function requireAdmin() {
  const store = await cookies();
  const user = await verifySessionToken(store.get(SESSION_COOKIE)?.value);
  if (!user) redirect("/login");
  return user;
}
