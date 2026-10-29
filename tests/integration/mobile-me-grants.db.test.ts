import { randomUUID } from "node:crypto";
import { EventPermission } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/*
 * GET /me with application-review grants (docs/ADMISSION.md): REVIEW_APPLICATIONS
 * opens its own workspace like JUDGE and MENTOR, so it is never listed as an
 * organiser collaboration, and it never breaks the account response.
 */

process.env.REDIS_URL = "";
process.env.TRUSTED_PROXY_IP_HEADER = "x-real-ip";

vi.mock("next-auth", () => ({ default: () => ({ auth: async () => null, handlers: {}, signIn: vi.fn(), signOut: vi.fn() }), CredentialsSignin: class extends Error {} }));
vi.mock("next-auth/providers/google", () => ({ default: vi.fn() }));
vi.mock("next-auth/providers/credentials", () => ({ default: vi.fn() }));
vi.mock("@/lib/authAdapter", () => ({ authAdapter: {} }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-real-ip": `198.18.0.${Math.floor(Math.random() * 250)}` }), cookies: async () => ({ get: () => undefined, set: vi.fn(), delete: vi.fn() }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/outboxWorker", () => ({ startOutboxWorker: vi.fn() }));

import { prisma } from "@/lib/db";
import { createEvent, createUser, get, none, signIn } from "../helpers/mobileApi";
import { GET as me } from "@/app/api/mobile/v1/me/route";

const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
const email = (name: string) => `${name}-${suffix}@example.test`;
const ids = { org: "", reviewOnly: "", mixed: "", reviewer: "", door: "" };

beforeAll(async () => {
  ids.org = (await prisma.organisation.create({ data: { name: "Review grants", slug: `mob-review-${suffix}` } })).id;
  ids.reviewOnly = await createEvent(ids.org, `review-only-${suffix}`);
  ids.mixed = await createEvent(ids.org, `review-mixed-${suffix}`);
  ids.reviewer = await createUser(email("reviewer"), "Reviewer");
  ids.door = await createUser(email("door"), "Door");
  await prisma.eventCollaborator.create({ data: { userId: ids.reviewer, eventId: ids.reviewOnly, permissions: [EventPermission.REVIEW_APPLICATIONS] } });
  await prisma.eventCollaborator.create({ data: { userId: ids.door, eventId: ids.reviewOnly, permissions: [EventPermission.REVIEW_APPLICATIONS] } });
  await prisma.eventCollaborator.create({ data: { userId: ids.door, eventId: ids.mixed, permissions: [EventPermission.CHECK_IN, EventPermission.REVIEW_APPLICATIONS] } });
});

afterAll(async () => {
  await prisma.organisation.deleteMany({ where: { id: ids.org } });
  await prisma.user.deleteMany({ where: { id: { in: [ids.reviewer, ids.door] } } });
});

describe("GET /me with application-review grants", () => {
  it("answers for a review-only collaborator, without listing the grant as organiser tools", async () => {
    const reviewer = await signIn(email("reviewer"));
    const response = await me(get("/api/mobile/v1/me", reviewer.accessToken), none);
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body.data.collaborations).toEqual([]);
  });

  it("lists only the organiser permissions of a mixed grant", async () => {
    const door = await signIn(email("door"));
    const response = await me(get("/api/mobile/v1/me", door.accessToken), none);
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body.data.collaborations).toEqual([expect.objectContaining({ eventId: ids.mixed, permissions: [EventPermission.CHECK_IN] })]);
  });
});
