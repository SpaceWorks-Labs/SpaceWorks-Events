import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { MembershipRole, PrismaClient } from "@prisma/client";
import { expect, test, type Browser, type Page } from "@playwright/test";

// The guide's owner/admin section (content/help/sections/developers.ts) opens
// for organisation owners and admins and stays a 404 for plain members. The
// gating is a reading convenience; the features themselves check access.
test.describe.configure({ mode: "serial", timeout: 120_000 });

const prisma = new PrismaClient();
const suffix = randomUUID().replace(/-/g, "").slice(0, 10);
const password = "help-gating-journey-password";
const people = { owner: `help-owner-${suffix}@example.test`, member: `help-member-${suffix}@example.test` };
let organisationId = "";
const userIds: string[] = [];
let ipCounter = 10;

test.beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  for (const email of Object.values(people)) {
    userIds.push((await prisma.user.create({ data: { email, name: email.split("@")[0], passwordHash, emailVerified: new Date() } })).id);
  }
  organisationId = (await prisma.organisation.create({
    data: {
      name: `Help ${suffix}`,
      slug: `help-${suffix}`,
      memberships: { create: [{ userId: userIds[0], role: MembershipRole.OWNER }, { userId: userIds[1], role: MembershipRole.MEMBER }] },
    },
  })).id;
});

test.afterAll(async () => {
  if (organisationId) await prisma.organisation.deleteMany({ where: { id: organisationId } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

async function signedIn(browser: Browser, email: string): Promise<Page> {
  const context = await browser.newContext();
  // Its own address block, so per-IP sign-in limits aren't shared with other specs.
  await context.setExtraHTTPHeaders({ "cf-connecting-ip": `198.18.11.${(ipCounter++ % 240) + 10}` });
  const page = await context.newPage();
  await page.goto("/login");
  const emailInput = page.getByRole("textbox", { name: /^Email/ });
  await expect.poll(() => emailInput.evaluate((node) => Object.keys(node).some((key) => key.startsWith("__reactFiber"))), { timeout: 60_000 }).toBe(true);
  await emailInput.fill(email);
  await page.locator('input[type="password"]:visible').fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect.poll(() => new URL(page.url()).pathname.startsWith("/login"), { timeout: 60_000 }).toBe(false);
  return page;
}

test("owners read the developer section, never stored by the browser", async ({ browser }) => {
  const page = await signedIn(browser, people.owner);
  const response = await page.goto("/help/developers/api");
  expect(response?.status()).toBe(200);
  expect(response?.headers()["cache-control"]).toContain("no-store");
  await expect(page.getByRole("heading", { level: 1, name: "The machine API" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Guide" }).first()).toContainText("Connecting other tools");
  await expect(page.getByRole("navigation", { name: "Guide" }).first()).not.toContainText("Instance administration");
  expect((await page.request.get("/help/instance/settings")).status()).toBe(404);
  await page.context().close();
});

test("plain members see only the public guide", async ({ browser }) => {
  const page = await signedIn(browser, people.member);
  expect((await page.request.get("/help/developers/api")).status()).toBe(404);
  const index = await page.request.get("/api/help/search-index");
  const body = (await index.json()) as { documents: Array<{ slug: string }> };
  expect(body.documents.some((doc) => doc.slug.startsWith("developers/"))).toBe(false);
  await page.context().close();
});
