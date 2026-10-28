import "./serverOnly";
import crypto from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { encryptMfaSecret } from "@/lib/mfa";
import { assertDisposableDatabase } from "../guard";
import { DAY } from "./common";

/**
 * Enrols an authenticator for every demo staff member (anyone with an
 * organisation membership), as the app requires of real staff. The capture
 * signs staff in with STAFF_MFA_REQUIRED=false and no codes, so this runs just
 * before the super-admin Security screen, after every staff screen is taken.
 * The secrets are random and never shown; the next run reseeds from scratch.
 */
export async function enrolDemoStaffAuthenticators(prisma: PrismaClient) {
  assertDisposableDatabase();
  const staff = await prisma.user.findMany({ where: { memberships: { some: {} }, mfaEnabledAt: null }, select: { id: true } });
  const enrolledAt = new Date(Date.now() - 20 * DAY);
  for (const { id } of staff) {
    // A base32 TOTP secret, like the ones the app's own enrolment creates.
    const secret = crypto.randomBytes(20).toString("hex").toUpperCase().replace(/[^A-Z2-7]/g, "A").slice(0, 32);
    await prisma.user.update({ where: { id }, data: { mfaSecretEncrypted: encryptMfaSecret(secret), mfaEnabledAt: enrolledAt } });
  }
  return staff.length;
}
