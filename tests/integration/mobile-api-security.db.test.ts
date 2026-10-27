import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { EventPermission } from "@prisma/client";

/*
 * The Space Works protections on the mobile API: the staff authenticator
 * rule on every organiser route (and in the helpers underneath), and the
 * password sign-in's emailed code for a new install.
 */

process.env.REDIS_URL = "";
process.env.NEXT_PUBLIC_BASE_URL = "https://events.example.test";
process.env.TRUSTED_PROXY_IP_HEADER = "x-real-ip";

vi.mock("next-auth", () => ({ default: () => ({ auth: async () => null, handlers: {}, signIn: vi.fn(), signOut: vi.fn() }), CredentialsSignin: class extends Error {} }));
vi.mock("next-auth/providers/google", () => ({ default: vi.fn() }));
vi.mock("next-auth/providers/credentials", () => ({ default: vi.fn() }));
vi.mock("@/lib/authAdapter", () => ({ authAdapter: {} }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-real-ip": `203.0.113.${Math.floor(Math.random() * 250)}` }), cookies: async () => ({ get: () => undefined, set: vi.fn(), delete: vi.fn() }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/outboxWorker", () => ({ startOutboxWorker: vi.fn() }));

import * as OTPAuth from "otpauth";
import { prisma } from "@/lib/db";
import { createMfaEnrollment, encryptMfaSecret } from "@/lib/mfa";
import { deviceHash } from "@/lib/loginSecurity";
import { issueMobileSession } from "@/lib/mobileAuth";
import { getMembership } from "@/lib/permissions";
import { confirmAuthenticator, createEvent, createUser, get, newDeviceId, none, params, post, PASSWORD, signIn } from "../helpers/mobileApi";
import { POST as login } from "@/app/api/mobile/v1/auth/login/route";
import { POST as mfa } from "@/app/api/mobile/v1/auth/mfa/route";
import { GET as me } from "@/app/api/mobile/v1/me/route";
import { GET as orgEvents } from "@/app/api/mobile/v1/orgs/[orgSlug]/events/route";
import { GET as eventDetail } from "@/app/api/mobile/v1/orgs/[orgSlug]/events/[eventId]/route";
import { GET as guestList } from "@/app/api/mobile/v1/orgs/[orgSlug]/events/[eventId]/guests/route";
import { POST as checkIn } from "@/app/api/mobile/v1/orgs/[orgSlug]/events/[eventId]/check-in/route";

const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
const email = (name: string) => `${name}-${suffix}@example.test`;
const ids = { org: "", event: "", admin: "", helper: "", newbie: "", attendee: "", traveller: "" };
const orgSlug = `mob-sec-${suffix}`;
let adminSecret = "";
/** An app session issued without an authenticator check, as after Google sign-in. */
async function googleStyleSession(userId: string) {
  const { sessionVersion } = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { sessionVersion: true } });
  const issued = await issueMobileSession({ userId, verifiedSessionVersion: sessionVersion, deviceHash: deviceHash(newDeviceId())!, method: "google", mfaVerified: false });
  return { accessToken: issued!.accessToken };
}
const currentCode = (secret: string) => new OTPAuth.TOTP({ algorithm: "SHA1", digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) }).generate();

beforeAll(async () => {
  vi.stubEnv("AUTH_SECRET", "integration-auth-secret-with-at-least-32-characters");
  vi.stubEnv("MFA_ENCRYPTION_KEY", process.env.MFA_ENCRYPTION_KEY || Buffer.alloc(32, 9).toString("base64"));
  ids.org = (await prisma.organisation.create({ data: { name: "Secure mobile", slug: orgSlug } })).id;
  ids.event = await createEvent(ids.org, `sec-event-${suffix}`);
  ids.admin = await createUser(email("admin"), "Admin", { mfaEnabledAt: new Date() });
  adminSecret = createMfaEnrollment(email("admin")).secret;
  await prisma.user.update({ where: { id: ids.admin }, data: { mfaSecretEncrypted: encryptMfaSecret(adminSecret) } });
  ids.helper = await createUser(email("helper"), "Helper", { mfaEnabledAt: new Date() });
  ids.newbie = await createUser(email("newbie"), "Newbie");
  ids.attendee = await createUser(email("attendee"), "Attendee");
  ids.traveller = await createUser(email("traveller"), "Traveller");
  await prisma.membership.createMany({ data: [
    { userId: ids.admin, organisationId: ids.org, role: "ADMIN" },
    { userId: ids.newbie, organisationId: ids.org, role: "MEMBER" },
  ] });
  await prisma.eventCollaborator.create({ data: { userId: ids.helper, eventId: ids.event, permissions: [EventPermission.CHECK_IN] } });
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await prisma.outboxMessage.deleteMany({ where: { payload: { path: ["to"], string_contains: suffix } } });
  await prisma.organisation.deleteMany({ where: { id: ids.org } });
  await prisma.user.deleteMany({ where: { id: { in: Object.values(ids).filter((id) => id && id !== ids.org && id !== ids.event) } } });
});

describe.sequential("mobile staff authenticator rule", () => {
  beforeAll(() => vi.stubEnv("STAFF_MFA_REQUIRED", "true"));
  afterAll(() => vi.stubEnv("STAFF_MFA_REQUIRED", "false"));

  const at = () => params({ orgSlug, eventId: ids.event });

  it("refuses every organiser route until the app session confirms an authenticator code", async () => {
    // A password sign-in asks for the code; a Google sign-in has none, so the session starts unverified.
    const asked = await login(post("/api/mobile/v1/auth/login", { email: email("admin"), password: PASSWORD, deviceId: newDeviceId() }), none);
    await expect(asked.json()).resolves.toMatchObject({ error: { code: "MFA_REQUIRED" } });
    const admin = await googleStyleSession(ids.admin);
    expect((await (await me(get("/x", admin.accessToken), none)).json()).data.staffMfa).toBe("verify");
    for (const response of [
      await orgEvents(get("/x", admin.accessToken), params({ orgSlug })),
      await eventDetail(get("/x", admin.accessToken), at()),
      await guestList(get("/x", admin.accessToken), at()),
    ]) {
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({ ok: false, error: { code: "STAFF_MFA_REQUIRED" } });
    }
    // A wrong code changes nothing.
    expect((await mfa(post("/x", { code: "000000" }, admin.accessToken), none)).status).toBe(400);
    expect((await eventDetail(get("/x", admin.accessToken), at())).status).toBe(403);

    const confirmed = await mfa(post("/x", { code: currentCode(adminSecret) }, admin.accessToken), none);
    expect(confirmed.status).toBe(200);
    expect((await (await me(get("/x", admin.accessToken), none)).json()).data.staffMfa).toBe("ok");
    await expect(prisma.auditEvent.count({ where: { action: "MOBILE_MFA_VERIFIED", actorUserId: ids.admin } })).resolves.toBe(1);
    expect((await eventDetail(get("/x", admin.accessToken), at())).status).toBe(200);
    expect((await guestList(get("/x", admin.accessToken), at())).status).toBe(200);
  });

  it("expires the app session's check after 12 hours", async () => {
    const admin = await googleStyleSession(ids.admin);
    await confirmAuthenticator(ids.admin);
    expect((await eventDetail(get("/x", admin.accessToken), at())).status).toBe(200);
    await prisma.mobileSession.updateMany({ where: { userId: ids.admin }, data: { mfaVerifiedAt: new Date(Date.now() - 13 * 60 * 60_000) } });
    expect((await eventDetail(get("/x", admin.accessToken), at())).status).toBe(403);
  });

  it("holds co-organisers to it too, and asks staff without an authenticator to set one up", async () => {
    const helper = await signIn(email("helper"));
    const refused = await checkIn(post("/x", { rsvpId: "missing" }, helper.accessToken), at());
    await expect(refused.json()).resolves.toMatchObject({ error: { code: "STAFF_MFA_REQUIRED" } });

    const newbie = await signIn(email("newbie"));
    const enrol = await orgEvents(get("/x", newbie.accessToken), params({ orgSlug }));
    expect(enrol.status).toBe(403);
    await expect(enrol.json()).resolves.toMatchObject({ error: { code: "STAFF_MFA_ENROLMENT_REQUIRED" } });
    expect((await mfa(post("/x", { code: "123456" }, newbie.accessToken), none)).status).toBe(403);
    expect((await (await me(get("/x", newbie.accessToken), none)).json()).data.staffMfa).toBe("enrol");
  });

  it("leaves attendees alone, and fails closed underneath with no actor and no cookie", async () => {
    const attendee = await signIn(email("attendee"));
    expect((await (await me(get("/x", attendee.accessToken), none)).json()).data.staffMfa).toBe("ok");
    // Outside a mobile request and without a cookie session, staff powers stay shut.
    expect(await getMembership(ids.admin, ids.org)).toBeNull();
  });
});

describe.sequential("mobile sign-in from a new install", () => {
  beforeAll(() => vi.stubEnv("LOGIN_NEW_DEVICE_CHECK", "true"));
  afterAll(() => vi.stubEnv("LOGIN_NEW_DEVICE_CHECK", "false"));

  const attempt = (deviceId: string, extra: Record<string, string> = {}) =>
    login(post("/api/mobile/v1/auth/login", { email: email("traveller"), password: PASSWORD, deviceId, platform: "ios", ...extra }), none);

  it("trusts the first install, then asks a new one for the emailed code", async () => {
    const first = newDeviceId();
    expect((await attempt(first)).status).toBe(200);
    expect((await attempt(first)).status).toBe(200);

    const second = newDeviceId();
    const challenged = await attempt(second);
    expect(challenged.status).toBe(401);
    await expect(challenged.json()).resolves.toMatchObject({ ok: false, error: { code: "EMAIL_CODE_REQUIRED" } });
    const message = await prisma.outboxMessage.findFirstOrThrow({ where: { kind: "sign-in-code", payload: { path: ["to"], equals: email("traveller") } }, orderBy: { createdAt: "desc" } });
    const code = (message.payload as { code: string; }).code;

    const wrong = await attempt(second, { emailCode: code === "000000" ? "000001" : "000000" });
    await expect(wrong.json()).resolves.toMatchObject({ error: { code: "UNAUTHENTICATED" } });
    const accepted = await attempt(second, { emailCode: code });
    expect(accepted.status).toBe(200);
    // The new install was remembered and an alert queued for the account.
    await expect(prisma.userDevice.count({ where: { userId: ids.traveller } })).resolves.toBe(2);
    await expect(prisma.outboxMessage.count({ where: { kind: "operator-notice", payload: { path: ["to"], equals: email("traveller") } } })).resolves.toBe(1);
  });
});
