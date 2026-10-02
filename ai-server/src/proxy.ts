import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/session";

export async function proxy(request: NextRequest) {
  const user = await verifySessionToken(request.cookies.get(SESSION_COOKIE)?.value);
  if (user) return NextResponse.next();

  if (request.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const login = new URL("/login", request.url);
  if (request.nextUrl.pathname !== "/") login.searchParams.set("next", request.nextUrl.pathname);
  return NextResponse.redirect(login);
}

// api/peers is excluded for the same reason as ws: an attached agent harness has no
// admin cookie, so that route authenticates itself with the peer's device token. Any
// route added under it must do the same.
export const config = {
  matcher: ["/((?!login|api/health|api/peers|ws|_next/static|_next/image|favicon.ico|icon.svg).*)"],
};
