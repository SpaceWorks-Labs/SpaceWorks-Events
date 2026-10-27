import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { isIP } from "node:net";
import { pageSecurity } from "@/lib/pageSecurity";
import { CLIENT_IP_HEADER, GATEWAY_HEADER, isFrontendPeer } from "@/lib/frontend/peer";
import { checkRateLimit } from "@/lib/rateLimit";

function tooMany(apiV1 = false, mobile = false) {
  return NextResponse.json(
    mobile
      ? { ok: false, error: { code: "RATE_LIMITED", message: "Too many requests. Try again later." } }
      : apiV1
      ? { error: { code: "RATE_LIMITED", message: "Too many requests. Try again later." } }
      : { error: "Too many requests. Try again later." },
    { status: 429, headers: { "Retry-After": "60", "Cache-Control": "no-store" } },
  );
}

function tooManyText() {
  return new NextResponse("Too many requests. Try again later.", {
    status: 429,
    headers: { "Retry-After": "60", "Cache-Control": "no-store" },
  });
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  // The peer credential authenticates only the frontend service, never a user.
  // Only an authenticated peer may supply the original browser address.
  if (request.headers.has(GATEWAY_HEADER)) {
    if (!isFrontendPeer(request.headers)) return new NextResponse("Not found", { status: 404 });
    const ip = request.headers.get(CLIENT_IP_HEADER)?.trim();
    const header = process.env.TRUSTED_PROXY_IP_HEADER;
    if (header && ["x-real-ip", "x-forwarded-for", "cf-connecting-ip"].includes(header)) request.headers.set(header, ip && isIP(ip) ? ip : "unknown");
  }
  if (process.env.DEPLOYMENT_MODE === "backend" && !pathname.startsWith("/api/") && !/\/(opengraph-image|twitter-image)(?:\/|$)/.test(pathname)) return new NextResponse("Not found", { status: 404 });

  // Server Actions post to page URLs, not /api. Apply one distributed ceiling
  // before any action-specific subject/IP limits run in the action itself.
  if (request.method === "POST" && request.headers.has("next-action")) {
    if (!(await checkRateLimit(request, "action"))) return tooMany();
  }

  if (pathname === "/discover") {
    if (!(await checkRateLimit(request, "search"))) return tooManyText();
  }

  // Liveness must not depend on Redis. Readiness remains protected because a
  // failed distributed limiter means the application is not fully ready.
  // Payment provider webhooks have their own bucket instead of the global one.
  const isPaymentWebhook = pathname.startsWith("/api/webhooks/");
  if (isPaymentWebhook) {
    if (!(await checkRateLimit(request, "paymentWebhook"))) return tooMany();
  } else if (pathname.startsWith("/api") && pathname !== "/api/health") {
    if (!(await checkRateLimit(request, "global"))) {
      return tooMany(pathname.startsWith("/api/v1"), pathname.startsWith("/api/mobile/"));
    }
  }

  // Mobile app sign-in shares the strict per-IP sign-in bucket with the web
  // (the credential verifier adds per-account limits). Mobile API requests are
  // bearer-authenticated route handlers: no cookies, CSRF or Server Action
  // origin checks apply, and nothing here redirects them.
  if ((pathname === "/api/mobile/v1/auth/login" || pathname === "/api/mobile/v1/auth/google") && request.method === "POST") {
    if (!(await checkRateLimit(request, "auth"))) return tooMany(false, true);
  }

  // Auth.js polls session, CSRF, and provider endpoints with GET requests.
  // Counting those reads against the strict sign-in bucket logs active users
  // out after a few tabs or routine session refreshes. Mutating auth requests
  // retain the dedicated protection; all reads remain under the global limit.
  if (pathname.startsWith("/api/auth") && request.method !== "GET") {
    if (!(await checkRateLimit(request, "auth"))) {
      return tooMany();
    }
  }

  if (pathname === "/api/uploads" && request.method !== "GET") {
    if (!(await checkRateLimit(request, "upload"))) {
      return tooMany();
    }
  }

  if (pathname === "/api/rsvp" && request.method === "POST") {
    if (!(await checkRateLimit(request, "rsvp"))) {
      return tooMany();
    }
  }

  if (pathname === "/api/search" && request.method === "GET") {
    if (!(await checkRateLimit(request, "search"))) {
      return tooMany();
    }
  }

  if (pathname === "/search") {
    if (!(await checkRateLimit(request, "search"))) {
      return tooManyText();
    }
  }

  if (pathname.startsWith("/api")) {
    const response = NextResponse.next({ request: { headers: new Headers(request.headers) } });
    if (process.env.FRONTEND_GATEWAY_SECRET && /^\/api\/ticket\/[^/]+\/(events|status)$/.test(pathname) && request.headers.get("origin") === process.env.NEXT_PUBLIC_BASE_URL) {
      response.headers.set("Access-Control-Allow-Origin", process.env.NEXT_PUBLIC_BASE_URL!);
      response.headers.append("Vary", "Origin");
    }
    response.headers.set("X-Frame-Options", "DENY");
    return response;
  }

  return pageSecurity(request);
}

export const config = {
  matcher: [
    "/api/:path*",
    "/search",
    {
      source: "/((?!api|_next/static|_next/image|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
