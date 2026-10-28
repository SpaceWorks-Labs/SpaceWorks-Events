import type { RsvpStatus } from "@prisma/client";

/**
 * Extract opaque check-in token from pasted text (raw token, URL path, or query).
 */
export function parseCheckInPayload(raw: string): string {
  const t = raw.trim();
  if (!t) return "";

  const tryUrl = (s: string) => {
    try {
      return new URL(s);
    } catch {
      return null;
    }
  };

  const withProto = /^[a-z][a-z0-9+.-]*:/i.test(t) ? t : `https://placeholder.local${t.startsWith("/") ? "" : "/"}${t}`;
  const u = tryUrl(withProto);
  if (u) {
    const parts = u.pathname.split("/").filter(Boolean);
    const last = parts[parts.length - 1];
    if (last && last.length >= 8) {
      const clean = last.split("?")[0];
      if (clean) return clean;
    }
    const qp =
      u.searchParams.get("t") ??
      u.searchParams.get("token") ??
      u.searchParams.get("q");
    if (qp?.trim()) return qp.trim();
  }

  const segments = t.split("/").filter(Boolean);
  const tail = segments[segments.length - 1]?.split("?")[0];
  if (tail && tail.length >= 8) return tail;
  return t.split("?")[0].trim();
}

export type CheckInGate =
  | { ok: true }
  | { ok: false; reason: string; needsForce: boolean; blocked?: boolean };

/** An application not yet accepted (docs/ADMISSION.md) has no place: no override admits it. */
export const APPLICANT_NO_PLACE = "This applicant's application hasn't been accepted, so they have no place and can't be checked in, even with an override.";

/**
 * `applicant`: the registration is (or is in a team that is) an admission
 * application that isn't ACCEPTED, as `commitCheckInProjection` reports it.
 */
export function gateCheckInForStatus(
  status: RsvpStatus,
  force: boolean,
  applicant = false,
): CheckInGate {
  if (status === "CONFIRMED") return { ok: true };
  if (applicant) return { ok: false, reason: APPLICANT_NO_PLACE, needsForce: false, blocked: true };
  if (status === "REJECTED") {
    return {
      ok: false,
      reason: "This registration was rejected.",
      needsForce: false,
      blocked: true,
    };
  }
  if (force && status === "WAITLISTED") {
    return { ok: true };
  }
  if (status === "WAITLISTED") {
    return {
      ok: false,
      reason: "Guest is on the waitlist — use “Override” to check in at the door.",
      needsForce: true,
    };
  }
  if (status === "PENDING_PAYMENT") {
    return {
      ok: false,
      reason: "Payment pending: this ticket isn't paid yet, so it can't be checked in.",
      needsForce: false,
      blocked: true,
    };
  }
  if (status === "PENDING_APPROVAL") {
    return {
      ok: false,
      reason: "Registration is pending approval and cannot be checked in.",
      needsForce: false,
      blocked: true,
    };
  }
  return {
    ok: false,
    reason: "This RSVP cannot be checked in.",
    needsForce: false,
    blocked: true,
  };
}
