import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { EventPrivacyType, EventStatus } from "@prisma/client";
import { expect } from "vitest";
import { prisma } from "@/lib/db";
import { POST as login } from "@/app/api/mobile/v1/auth/login/route";

/*
 * Shared pieces for the mobile API integration suites. Each suite mocks
 * Auth.js itself (it can't load under Vitest), so the real lib/auth.ts runs
 * and presents the app session to Server Action bodies.
 */

export const BASE = "https://events.example.test";
export const PASSWORD = "correct horse battery staple";

/** Each request comes from its own address so the per-IP sign-in buckets never throttle a suite. */
function address() {
  return `198.51.100.${Math.floor(Math.random() * 250) + 1}`;
}

export function post(path: string, body: unknown, token?: string) {
  return new Request(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-real-ip": address(), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
}

export function get(path: string, token?: string) {
  return new Request(`${BASE}${path}`, { headers: { "x-real-ip": address(), ...(token ? { authorization: `Bearer ${token}` } : {}) } });
}

export function del(path: string, token: string) {
  return new Request(`${BASE}${path}`, { method: "DELETE", headers: { "x-real-ip": address(), authorization: `Bearer ${token}` } });
}

export const params = <T extends Record<string, string>>(value: T) => ({ params: Promise.resolve(value) });
export const none = params({});

/** A fresh app install id (32 to 64 lowercase hex). */
export const newDeviceId = () => randomBytes(24).toString("hex");

export async function createUser(email: string, name: string, extra: { mfaEnabledAt?: Date; } = {}) {
  const user = await prisma.user.create({ data: { email, name, emailVerified: new Date(), passwordHash: await bcrypt.hash(PASSWORD, 4), ...extra } });
  return user.id;
}

export async function createEvent(organisationId: string, slug: string, extra: Record<string, unknown> = {}) {
  const event = await prisma.event.create({ data: {
    organisationId, title: `Mobile ${slug}`, slug,
    startDateTime: new Date(Date.now() + 2 * 60 * 60_000), endDateTime: new Date(Date.now() + 4 * 60 * 60_000),
    timezone: "UTC", status: EventStatus.PUBLISHED, privacyType: EventPrivacyType.PUBLIC,
    page: { create: { isPublished: true } },
    ...extra,
  } });
  return event.id;
}

export type SignedIn = { accessToken: string; refreshToken: string; deviceId: string; };

export async function signIn(email: string, options: { deviceName?: string; deviceId?: string; } = {}): Promise<SignedIn> {
  const deviceId = options.deviceId ?? newDeviceId();
  const response = await login(post("/api/mobile/v1/auth/login", { email, password: PASSWORD, deviceId, deviceName: options.deviceName ?? "Test phone", platform: "android" }), none);
  const body = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(200);
  return { ...(body.data as { accessToken: string; refreshToken: string; }), deviceId };
}

/** Mark every live app session of a user as having passed an authenticator check now. */
export async function confirmAuthenticator(userId: string) {
  await prisma.mobileSession.updateMany({ where: { userId, revokedAt: null }, data: { mfaVerifiedAt: new Date() } });
}
