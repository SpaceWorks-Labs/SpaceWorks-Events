import "server-only";

import { cookies } from "next/headers";
import { decode } from "next-auth/jwt";

/** The Auth.js session cookie (lib/auth.ts); also the salt its JWT is encrypted with. */
export const SESSION_COOKIE_NAME = "swe.session-token.v1";

/**
 * The session token from the request's cookies. Auth.js splits a large token
 * across `<name>.0`, `<name>.1`, …; the parts are joined in index order, as
 * Auth.js's own session store does.
 */
export function sessionTokenFromCookies(all: Array<{ name: string; value: string }>): string | null {
  const parts: Array<{ index: number; value: string }> = [];
  for (const { name, value } of all) {
    if (!value) continue;
    if (name === SESSION_COOKIE_NAME) parts.push({ index: 0, value });
    const chunk = name.startsWith(`${SESSION_COOKIE_NAME}.`) ? name.slice(SESSION_COOKIE_NAME.length + 1) : "";
    if (/^\d+$/.test(chunk)) parts.push({ index: Number(chunk), value });
  }
  return parts.length > 0 ? parts.sort((a, b) => a.index - b.index).map((part) => part.value).join("") : null;
}

/**
 * The sign-in id (`sid`) of this browser's session, read on the server only.
 * It is never put on the session object, so `/api/auth/session` does not
 * return it. The cookie is decoded with the secret and salt Auth.js uses, and
 * the sid counts only when the token belongs to `userId`, the user `auth()`
 * already validated for this request. Null when there is no such session (a
 * mobile request has no session cookie).
 */
export async function currentSessionSid(userId: string): Promise<string | null> {
  const token = sessionTokenFromCookies((await cookies()).getAll());
  const secret = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
  if (!token || !secret) return null;
  try {
    const payload = await decode({ token, secret, salt: SESSION_COOKIE_NAME });
    return payload?.sub === userId && typeof payload.sid === "string" && payload.sid ? payload.sid : null;
  } catch {
    return null;
  }
}
