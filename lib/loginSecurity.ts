import "server-only";

import crypto from "crypto";
import { prisma } from "@/lib/db";
import { enqueueOperatorNotice, enqueueSignInCode } from "@/lib/outbox";
import { checkRateLimitById, failureCount, isOverLimit, recordFailure } from "@/lib/rateLimit";
import { isSuperAdminEmail } from "@/lib/superAdminEmail";

/**
 * Sign-in protections, like large sites use:
 * - an address with many failed sign-ins in an hour is blocked from signing in;
 * - a password sign-in from a device the account hasn't used (or after several
 *   failures) needs a code emailed to the account, unless an authenticator
 *   code was given;
 * - a sign-in from a new device sends a "new sign-in" alert.
 * `LOGIN_NEW_DEVICE_CHECK=false` turns the device code off (tests only).
 */

/** The browser's random device id, sent with the sign-in form. */
export const DEVICE_ID = /^[a-f0-9]{32,64}$/;
const CODE_TTL_MS = 10 * 60_000;

const sha256 = (value: string) => crypto.createHash("sha256").update(value).digest("hex");
const accountKey = (email: string) => `subject:${sha256(email.trim().toLowerCase()).slice(0, 32)}`;
const ipKey = (ip: string) => `ip:${ip}`;

export function newDeviceCheckEnabled() {
  return process.env.LOGIN_NEW_DEVICE_CHECK?.trim().toLowerCase() !== "false";
}

/** Behind an untrusted proxy every client looks like "unknown": never block that. */
export async function isAddressBlocked(ip: string) {
  return ip !== "unknown" && isOverLimit("loginFailureIp", await failureCount("loginFailureIp", ipKey(ip)));
}

export async function noteFailedSignIn(ip: string, email: string) {
  await Promise.all([
    ip === "unknown" ? Promise.resolve(0) : recordFailure("loginFailureIp", ipKey(ip)),
    recordFailure("loginFailureAccount", accountKey(email)),
  ]);
}

/** Several recent failures on this account: ask for an emailed code even with the right password. */
export async function accountUnderAttack(email: string) {
  return isOverLimit("loginFailureAccount", await failureCount("loginFailureAccount", accountKey(email)));
}

/** Far past that: stop accepting codes too, until the window passes. */
export async function accountLocked(email: string) {
  return (await failureCount("loginFailureAccount", accountKey(email))) >= 15;
}

export function deviceHash(deviceId: string | undefined | null) {
  return deviceId && DEVICE_ID.test(deviceId) ? sha256(`device:${deviceId}`) : null;
}

export async function knownDevice(userId: string, hash: string | null) {
  const [known, any] = await Promise.all([
    hash ? prisma.userDevice.findUnique({ where: { userId_deviceHash: { userId, deviceHash: hash } }, select: { id: true } }) : null,
    prisma.userDevice.findFirst({ where: { userId }, select: { id: true } }),
  ]);
  return { known: Boolean(known), firstDevice: !any };
}

/** Email a fresh six-digit code (replacing any earlier one). False when too many were sent lately. */
export async function sendSignInCode(user: { id: string; email: string; }) {
  if (!(await checkRateLimitById("loginCode", accountKey(user.email)))) return false;
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
  const expires = new Date(Date.now() + CODE_TTL_MS);
  await prisma.$transaction(async (tx) => {
    await tx.verificationToken.deleteMany({ where: { identifier: `sign-in:${user.id}` } });
    await tx.verificationToken.create({ data: { identifier: `sign-in:${user.id}`, token: sha256(`sign-in:${user.id}:${code}`), expires } });
    await enqueueSignInCode(tx, { to: user.email, code, expiresAt: expires.toISOString() });
  });
  return true;
}

/** A correct, unexpired code is used up; anything else fails. */
export async function consumeSignInCode(userId: string, code: string) {
  if (!/^\d{6}$/.test(code)) return false;
  const used = await prisma.verificationToken.deleteMany({
    where: { identifier: `sign-in:${userId}`, token: sha256(`sign-in:${userId}:${code}`), expires: { gt: new Date() } },
  });
  return used.count === 1;
}

/** The Space Works mobile app sends `SpaceWorksEvents/<version> (<Android|iOS> …)`. */
export function describeBrowser(userAgent: string) {
  if (/^SpaceWorksEvents\//.test(userAgent)) return `the Space Works app on ${/iOS|iPhone|iPad/.test(userAgent) ? "iOS" : /Android/.test(userAgent) ? "Android" : "a phone"}`;
  const browser = /Edg\//.test(userAgent) ? "Edge" : /Firefox\//.test(userAgent) ? "Firefox" : /Chrome\//.test(userAgent) ? "Chrome" : /Safari\//.test(userAgent) ? "Safari" : "A browser";
  const system = /Windows/.test(userAgent) ? "Windows" : /Android/.test(userAgent) ? "Android" : /iPhone|iPad/.test(userAgent) ? "iOS" : /Mac OS X/.test(userAgent) ? "macOS" : /Linux/.test(userAgent) ? "Linux" : "an unknown system";
  return `${browser} on ${system}`;
}

/**
 * What to do about a sign-in that wasn't you. The super admin can't reset
 * their password in the app (it is set only from the server), so they are
 * pointed to the server tools instead.
 */
export function newSignInAdvice(email: string): string {
  if (isSuperAdminEmail(email)) {
    return "If it wasn't, set a new password on the server now (sudo bash scripts/vps-recover.sh on the VPS, or recover-super-admin.mjs with database access), then use “Sign out everywhere” under Account security.";
  }
  return "If it wasn't, reset your password from the sign-in page now, then use “Sign out everywhere” under Account security.";
}

/**
 * Remember the device this sign-in came from. A device the account hasn't
 * used before (other than its very first) sends a "new sign-in" alert. A
 * missing or malformed device id counts as an unknown device: it is audited
 * and alerted every time, and only remembering it needs a usable hash.
 */
export async function rememberSignIn(params: { userId: string; email: string; hash: string | null; ip: string; userAgent: string; firstDevice: boolean; }) {
  const userAgent = describeBrowser(params.userAgent);
  const lastIp = params.ip === "unknown" ? null : params.ip.slice(0, 64);
  const hash = params.hash;
  if (hash) {
    const existing = await prisma.userDevice.findUnique({ where: { userId_deviceHash: { userId: params.userId, deviceHash: hash } }, select: { id: true } });
    if (existing) {
      await prisma.userDevice.update({ where: { id: existing.id }, data: { lastSeenAt: new Date(), lastIp, userAgent } });
      return;
    }
  }
  await prisma.$transaction(async (tx) => {
    if (hash) await tx.userDevice.create({ data: { userId: params.userId, deviceHash: hash, userAgent, lastIp } });
    await tx.auditEvent.create({ data: { action: "SIGN_IN_NEW_DEVICE", actorUserId: params.userId, targetType: "User", targetId: params.userId } });
    if (!params.firstDevice) {
      await enqueueOperatorNotice(tx, {
        to: params.email,
        subject: "New sign-in to your account",
        lines: [
          `Your Space Works Events account was signed in to from ${userAgent}${lastIp ? ` (network address ${lastIp})` : ""} at ${new Date().toUTCString()}.`,
          "If this was you, there's nothing to do.",
          newSignInAdvice(params.email),
        ],
      });
    }
  });
}
