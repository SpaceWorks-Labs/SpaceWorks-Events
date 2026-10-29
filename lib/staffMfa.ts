import "server-only";

import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { hasValidMfaProof, MFA_PROOF_COOKIE } from "@/lib/mfaProof";
import { mobileMfaFresh } from "@/lib/staffMfaFresh";
import { currentRequestActor } from "@/lib/requestActor";
import { isSuperAdminEmail } from "@/lib/superAdminEmail";
import { currentSessionSid } from "@/lib/sessionSid";

/**
 * Organisation staff (anyone with a membership, or an event or series
 * co-organiser) must use an authenticator app: set up, and checked in this
 * session, either at the password sign-in or afterwards on /verify-mfa (after
 * Google). Attendees and the super admin are not staff here.
 * `STAFF_MFA_REQUIRED=false` turns this off (local development and tests).
 */
export type StaffMfaState = "ok" | "enrol" | "verify";

export function isStaffMfaRequired() {
  return process.env.STAFF_MFA_REQUIRED?.trim().toLowerCase() !== "false";
}

/** Whether this person holds any staff role, in any organisation. */
export async function isStaff(userId: string) {
  const [membership, grant] = await Promise.all([
    prisma.membership.findFirst({ where: { userId }, select: { userId: true } }),
    prisma.eventCollaborator.findFirst({ where: { userId }, select: { id: true } }),
  ]);
  return Boolean(membership || grant);
}

async function standing(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, mfaEnabledAt: true, sessionVersion: true } });
  if (!user || isSuperAdminEmail(user.email) || !(await isStaff(userId))) return { exempt: true as const };
  return { exempt: false as const, user };
}

/**
 * The acting person's MFA standing, once per request. Checks about someone
 * else (a member being removed) are never affected: only the person acting
 * on this request is held to it.
 *
 * A mobile app request runs as an explicit actor (`lib/requestActor.ts`) and
 * carries its own proof: the app session's `mfaVerifiedAt`, valid for the
 * same 12 hours as the web proof cookie. A request with neither an actor nor
 * a cookie session (a bearer request that forgot to declare its actor) fails
 * closed instead of passing.
 */
export const staffMfaState = cache(async (userId: string): Promise<StaffMfaState> => {
  if (!isStaffMfaRequired()) return "ok";
  const actor = currentRequestActor();
  if (actor?.kind === "anonymous") {
    // Nobody is signed in on this request: a staff check fails closed.
    const state = await standing(userId);
    return state.exempt ? "ok" : state.user.mfaEnabledAt ? "verify" : "enrol";
  }
  if (actor) {
    if (actor.userId !== userId) return "ok";
    const state = await standing(userId);
    if (state.exempt) return "ok";
    if (!state.user.mfaEnabledAt) return "enrol";
    return mobileMfaFresh(actor.mfaVerifiedAt) ? "ok" : "verify";
  }
  const session = await auth().catch(() => null);
  if (session?.user?.id && session.user.id !== userId) return "ok";
  const state = await standing(userId);
  if (state.exempt) return "ok";
  if (!state.user.mfaEnabledAt) return "enrol";
  if (!session?.user?.id) return "verify";
  if ((session as typeof session & { mfaVerified?: boolean; }).mfaVerified) return "ok";
  const proof = (await cookies()).get(MFA_PROOF_COOKIE)?.value;
  // The proof counts only for the sign-in it was issued to.
  return hasValidMfaProof(proof, userId, state.user.sessionVersion, proof ? await currentSessionSid(userId) : null) ? "ok" : "verify";
});

/** For staff checks in actions: false while the signed-in staff member still owes an authenticator check. */
export async function staffMfaSatisfied(userId: string) {
  return (await staffMfaState(userId)) === "ok";
}

/** For staff pages: send staff to set up or confirm their authenticator first. */
export async function requireStaffMfa(userId: string, next: string) {
  const state = await staffMfaState(userId);
  if (state === "enrol") redirect("/account/security?mfa=required");
  if (state === "verify") redirect(`/verify-mfa?next=${encodeURIComponent(next)}`);
}
