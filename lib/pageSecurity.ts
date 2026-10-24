import { NextResponse, type NextRequest } from "next/server";

/** Pages whose URL is itself the credential: `/ticket/{token}`, `/team/{token}`, `/submit/{token}`, `/{org}/{event}/team/{joinToken}`. */
function isCapabilityPage(pathname: string): boolean {
  return /^\/(?:ticket|team|submit)\/[^/]+\/?$/.test(pathname) || /^\/[^/]+\/[^/]+\/team\/[^/]+\/?$/.test(pathname);
}

export function pageSecurity(request: NextRequest) {
  const isEmbed = /^\/embed\/[^/]+\/[^/]+$/.test(request.nextUrl.pathname);
  const ancestors = isEmbed ? [...new Set((process.env.ALLOWED_EMBED_ORIGINS ?? "").split(",").map((v) => v.trim()).filter((value) => {
    try { const url = new URL(value); return url.origin === value && ["http:", "https:"].includes(url.protocol); } catch { return false; }
  }))] : [];
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const nonce = btoa(String.fromCharCode(...bytes));
  const testBackend = process.env.CI === "true" && process.env.ALLOW_INSECURE_PRODUCTION_TESTS === "1" && /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(process.env.NEXT_PUBLIC_BACKEND_ORIGIN ?? "") ? ` ${process.env.NEXT_PUBLIC_BACKEND_ORIGIN}` : "";
  const csp = [
    "default-src 'self'", "base-uri 'self'", "object-src 'none'",
    `frame-ancestors ${isEmbed && ancestors.length ? ancestors.join(" ") : "'none'"}`,
    "frame-src https://maps.google.com https://www.google.com", "form-action 'self'",
    "img-src 'self' data: blob: https:", "font-src 'self' data: https:", `connect-src 'self' https:${testBackend}`,
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    ...(process.env.NODE_ENV === "production" ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
  const incoming = new Headers(request.headers);
  incoming.set("Content-Security-Policy", csp);
  incoming.set("x-nonce", nonce);
  const response = NextResponse.next({ request: { headers: incoming } });
  response.headers.set("Content-Security-Policy", csp);
  // Bearer-capability pages (ticket, team management and team join links;
  // docs/TEAMS.md) must never be stored by a browser or shared cache. This
  // header replaces Next's own `private, no-store` in production, so say it here.
  response.headers.set("Cache-Control", isCapabilityPage(request.nextUrl.pathname) ? "private, no-cache, no-store, max-age=0, must-revalidate, no-transform" : "no-transform");
  if (!isEmbed) response.headers.set("X-Frame-Options", "DENY");
  return response;
}
