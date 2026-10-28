import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";
import { expect, test } from "@playwright/test";
import { encodeWire, decodeWire } from "../../lib/frontend/codec";

test.describe("separate frontend and backend", () => {
  test.skip(process.env.PLAYWRIGHT_SPLIT !== "1", "Requires the separate disposable backend server.");
  const prisma = new PrismaClient();
  const suffix = randomUUID().replaceAll("-", "");
  const email = `split-${suffix}@example.test`;
  const slug = `split-${suffix}`;
  const otherSlug = `other-${suffix}`;
  let userId: string, organisationId: string, otherId: string, eventId: string, ticket: string;

  test.beforeAll(async () => {
    const user = await prisma.user.create({ data: { email, name: "Split owner", passwordHash: await bcrypt.hash("disposable-browser-password", 12), emailVerified: new Date() } });
    userId = user.id;
    const organisation = await prisma.organisation.create({ data: { slug, name: "Split hosting", memberships: { create: { userId, role: "OWNER" } } } });
    organisationId = organisation.id;
    otherId = (await prisma.organisation.create({ data: { slug: otherSlug, name: "Other tenant" } })).id;
    const event = await prisma.event.create({ data: { organisationId, title: "Split event", slug: "split-event", status: "PUBLISHED", startDateTime: new Date("2030-01-01T10:00Z"), endDateTime: new Date("2030-01-01T11:00Z"), timezone: "UTC", location: "Venue", page: { create: { isPublished: true } }, checkInStationPinHash: await bcrypt.hash("disposable-pin", 10) } });
    eventId = event.id;
    ticket = (await prisma.rSVP.create({ data: { eventId, userId, attendeeKey: `user:${userId}`, status: "CONFIRMED" } })).checkInToken;
  });
  test.afterAll(async () => {
    if (organisationId) await prisma.organisation.deleteMany({ where: { id: { in: [organisationId, otherId] } } });
    if (userId) await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  });

  test("renders tenant views, forwards a mutation, enforces tenant guards and scopes ticket CORS", async ({ page, context, baseURL }) => {
    await context.setExtraHTTPHeaders({ "x-real-ip": "192.0.2.249" });
    await page.goto("/login?callbackUrl=%2Fdashboard");
    await page.getByRole("textbox", { name: /^Email/ }).fill(email);
    await page.locator('input[type="password"]:visible').fill("disposable-browser-password");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page).toHaveURL(/\/dashboard$/);
    const cookie = (await context.cookies()).map((item) => `${item.name}=${item.value}`).join("; ");
    const headers = { origin: baseURL!, cookie, "x-swe-frontend-key": process.env.FRONTEND_GATEWAY_SECRET!, "x-swe-frontend-client-ip": "192.0.2.249" };
    const peer = async (kind: string, endpoint: string, args: unknown[]) => {
      const response = await context.request.post(`${process.env.BACKEND_ORIGIN}/api/frontend/${kind}/${encodeURIComponent(endpoint)}`, { headers, data: await encodeWire(args) });
      expect(response.status(), endpoint).toBe(200);
      return response.json();
    };
    const readers = [
      ["app__account__page:loadAccountView", []],
      ["app__account__security__page:loadAccountSecurityView", []],
      ["app__account__registrations__page:loadAccountRegistrationsView", [{ searchParams: {} }]],
      ["app__dashboard__orgSlug__page:loadOrgDashboardView", [{ params: { orgSlug: slug }, searchParams: {} }]],
      ["app__dashboard__orgSlug__settings__page:loadOrgSettingsView", [{ params: { orgSlug: slug } }]],
      ["app__dashboard__orgSlug__event__eventId__page:loadEventManageView", [{ params: { orgSlug: slug, eventId } }]],
      ...["Overview", "Guests", "EventPage", "Emails", "CheckIn", "Feedback", "Analytics", "Settings"].map((name) => [`components__event-dashboard__panels__${name}Panel:load${name}Panel`, [{ ctx: { organisation: { slug }, event: { id: eventId } } }]]),
    ] as const;
    for (const [endpoint, args] of readers) {
      const result = await peer("view", endpoint as string, args as unknown[]);
      expect(result.ok, endpoint as string).toBe(true);
      expect(JSON.stringify(result)).not.toMatch(/"(?:passwordHash|checkInStationPinHash|checkInStationPinEncrypted|mfaSecretEncrypted)"/);
    }
    const denied = await peer("view", "app__dashboard__orgSlug__event__eventId__page:loadEventManageView", [{ params: { orgSlug: otherSlug, eventId } }]);
    expect(denied.navigation).toEqual({ type: "redirect", location: "/dashboard" });
    const forbidden = await peer("action", "org:updateOrganisation", [{ organisationSlug: otherSlug, name: "Forbidden change", logoUrl: "" }]);
    expect(decodeWire(forbidden.value)).toMatchObject({ ok: false });
    await prisma.membership.create({ data: { organisationId: otherId, userId, role: "OWNER" } });
    const mismatch = await peer("view", "app__dashboard__orgSlug__event__eventId__page:loadEventManageView", [{ params: { orgSlug: otherSlug, eventId } }]);
    expect(mismatch.navigation?.type).toBe("not-found");
    const update = await peer("action", "org:updateOrganisation", [{ organisationSlug: slug, name: "Updated through gateway", description: "Test", logoUrl: "" }]);
    expect(decodeWire(update.value)).toMatchObject({ ok: true });
    expect(update.invalidations).toContainEqual({ path: `/dashboard/${slug}` });
    expect((await prisma.organisation.findUniqueOrThrow({ where: { id: organisationId } })).name).toBe("Updated through gateway");
    const protectedApi = await context.request.post(`${baseURL}/api/%66rontend/action/org%3AupdateOrganisation`, { data: [] });
    expect(protectedApi.status()).toBe(404);
    const status = `${process.env.BACKEND_ORIGIN}/api/ticket/${ticket}/status`;
    const allowed = await context.request.get(status, { headers: { origin: baseURL! } });
    expect(allowed.headers()["access-control-allow-origin"]).toBe(baseURL);
    const rejected = await context.request.get(status, { headers: { origin: "https://untrusted.example.test" } });
    expect(rejected.headers()["access-control-allow-origin"]).toBeUndefined();
    expect((await context.request.get(`${process.env.BACKEND_ORIGIN}/dashboard`, { maxRedirects: 0 })).status()).toBe(404);
  });
  test("opens the super-admin panel with email and password and keeps settings secrets on the VPS", async ({ page, context }) => {
    const admin = await prisma.user.create({ data: { email: process.env.SUPER_ADMIN_EMAIL!, name: "Split admin", passwordHash: await bcrypt.hash("disposable-admin-password", 12), emailVerified: new Date() } });
    try {
      await context.setExtraHTTPHeaders({ "x-real-ip": "192.0.2.250" });
      await page.goto("/login?callbackUrl=%2Fdashboard");
      await page.getByRole("textbox", { name: /^Email/ }).fill(admin.email!);
      await page.locator('input[type="password"]:visible').fill("disposable-admin-password");
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await expect(page).toHaveURL(/\/dashboard$/);
      // The super admin needs no authenticator step: the panel opens straight away.
      await prisma.instanceSetting.upsert({ where: { id: "global" }, create: { id: "global", smtpPasswordEncrypted: "fixture-ciphertext" }, update: { smtpPasswordEncrypted: "fixture-ciphertext" } });
      for (const path of ["", "/settings", "/operations", "/auth", "/activity", "/audit", "/email", "/events", "/invites", "/monitoring", "/orgs", "/security", "/storage", "/users", `/users/${admin.id}`, `/orgs/${organisationId}`]) {
        const response = await page.goto(`/super-admin${path}`);
        expect(response?.status(), path).toBe(200);
        expect(await page.content()).not.toContain("fixture-ciphertext");
      }
    } finally {
      await prisma.instanceSetting.deleteMany({ where: { id: "global" } });
      await prisma.user.deleteMany({ where: { id: admin.id } });
    }
  });

});
