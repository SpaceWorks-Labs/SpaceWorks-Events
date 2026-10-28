// Sets or resets the super admin's password: the only way to do either, since
// the app never emails a reset link for that address and refuses its sign-up.
// Run as root on the server through the ops role (scripts/vps-recover.sh), or
// anywhere with DATABASE_URL and NEXT_PUBLIC_BASE_URL set:
//   node docker/vps/recover-super-admin.mjs [email]
// The first time, it creates the account (email verified). Otherwise it
// removes the account's authenticator and recovery codes and signs out every
// session. Either way it prints a one-hour link to set the password.
// The email defaults to SUPER_ADMIN_EMAIL. The link is printed only here.
import { createHash, randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";

const email = (process.argv[2] || process.env.SUPER_ADMIN_EMAIL || "").trim().toLowerCase();
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
  console.error("Usage: recover-super-admin.mjs [email]; SUPER_ADMIN_EMAIL is not set to an email address.");
  process.exit(1);
}
const baseUrl = (process.env.NEXT_PUBLIC_BASE_URL || "").replace(/\/$/, "");
const prisma = new PrismaClient();
try {
  const token = randomBytes(32).toString("hex");
  const user = await prisma.$transaction(async (tx) => {
    const existing = await tx.user.findUnique({ where: { email }, select: { id: true } });
    const found = existing ?? await tx.user.create({ data: { email, name: "Super admin", emailVerified: new Date() }, select: { id: true } });
    await tx.user.update({
      where: { id: found.id },
      data: { mfaSecretEncrypted: null, mfaEnabledAt: null, recoveryCodeHashes: [], sessionVersion: { increment: 1 } },
    });
    await tx.session.deleteMany({ where: { userId: found.id } });
    await tx.mobileSession.updateMany({ where: { userId: found.id, revokedAt: null }, data: { revokedAt: new Date() } });
    // The same one-time, hashed token the reset-password page accepts.
    await tx.verificationToken.deleteMany({ where: { identifier: `reset:${email}` } });
    await tx.verificationToken.create({
      data: { identifier: `reset:${email}`, token: createHash("sha256").update(token).digest("hex"), expires: new Date(Date.now() + 60 * 60 * 1000) },
    });
    await tx.auditEvent.create({ data: { action: "OPERATOR_ACCOUNT_RECOVERY", targetType: "User", targetId: found.id, metadata: { mfaReset: true, sessionsRevoked: true, created: !existing } } });
    return { ...found, created: !existing };
  });
  if (user.created) {
    console.log(`Created the account ${email}.`);
    console.log("Open this link within an hour to set its password, then sign in and set up an authenticator:");
  } else {
    console.log(`Authenticator and recovery codes removed, and every session signed out, for ${email}.`);
    console.log("Open this link within an hour to set a new password, then sign in and set up an authenticator again:");
  }
  console.log(`${baseUrl}/reset-password?token=${token}&email=${encodeURIComponent(email)}`);
} finally {
  await prisma.$disconnect();
}
