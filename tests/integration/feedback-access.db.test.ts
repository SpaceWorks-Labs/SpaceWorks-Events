import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EventPrivacyType } from "@prisma/client";

// Never let an ambient Redis or base URL leak into this suite.
process.env.REDIS_URL = "";
process.env.NEXT_PUBLIC_BASE_URL = "https://events.example.test";
process.env.TRUSTED_PROXY_IP_HEADER = "x-real-ip";

// Auth.js can't load under Vitest; the real lib/auth.ts presents the app
// session to bearer requests, and `web.session` stands in for a browser cookie.
const web = vi.hoisted(() => ({ session: null as null | { user: { id: string; }; } }));
vi.mock("next-auth", () => ({ default: () => ({ auth: async () => web.session, handlers: {}, signIn: vi.fn(), signOut: vi.fn() }), CredentialsSignin: class extends Error {} }));
vi.mock("next-auth/providers/google", () => ({ default: vi.fn() }));
vi.mock("next-auth/providers/credentials", () => ({ default: vi.fn() }));
vi.mock("@/lib/authAdapter", () => ({ authAdapter: {} }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-real-ip": "198.51.100.20" }), cookies: async () => ({ get: () => undefined, getAll: () => [], set: vi.fn(), delete: vi.fn() }) }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("not-found"); }, redirect: (path: string) => { throw new Error(`redirect:${path}`); } }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/outboxWorker", () => ({ startOutboxWorker: vi.fn() }));

import { prisma } from "@/lib/db";
import { appSession, createEvent, createUser, get, params, post } from "../helpers/mobileApi";
import { submitFeedback } from "@/lib/feedback";
import { loadFeedbackView } from "@/lib/views/app__orgSlug__eventSlug__feedback__page";
import { GET as mobileFeedback } from "@/app/api/mobile/v1/public/events/[orgSlug]/[eventSlug]/feedback/route";
import { POST as feedbackRoute } from "@/app/api/feedback/route";

/*
 * Feedback follows the event page's access rule (lib/publicEventAccess.ts): an
 * invite-only event's form is for signed-in invited guests, and nothing is
 * open while the event's website is unreleased. Web page, web submission and
 * the app's form and submission all agree.
 */
const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
const orgSlug = `feedback-access-${suffix}`;
const slugs = { invite: `invite-${suffix}`, unreleased: `unreleased-${suffix}`, open: `open-${suffix}` };
const users = { invited: "", stranger: "" };
let organisationId = "";

const form = { create: { isOpen: true, fields: { create: [{ key: "comment", label: "Comment", type: "TEXTAREA" as const, required: true, sortOrder: 1 }] } } };
const answer = (eventSlug: string) => ({ orgSlug, eventSlug, answers: { comment: "Useful" } });
const page = (eventSlug: string) => loadFeedbackView({ params: Promise.resolve({ orgSlug, eventSlug }) });
const appForm = (eventSlug: string, token?: string) => mobileFeedback(get(`/api/mobile/v1/public/events/${orgSlug}/${eventSlug}/feedback`, token), params({ orgSlug, eventSlug }));
const appSubmit = (eventSlug: string, token?: string) => {
  const request = post("/api/feedback", answer(eventSlug), token);
  request.headers.delete("idempotency-key");
  return feedbackRoute(request);
};

beforeAll(async () => {
  organisationId = (await prisma.organisation.create({ data: { name: "Feedback access", slug: orgSlug } })).id;
  users.invited = await createUser(`invited-${suffix}@example.test`, "Invited guest");
  users.stranger = await createUser(`stranger-${suffix}@example.test`, "Stranger");
  const invite = await createEvent(organisationId, slugs.invite, { privacyType: EventPrivacyType.INVITE_ONLY, feedbackForm: form });
  await prisma.eventInvite.create({ data: { eventId: invite, email: `invited-${suffix}@example.test` } });
  await createEvent(organisationId, slugs.unreleased, { page: { create: { isPublished: false } }, feedbackForm: form });
  await createEvent(organisationId, slugs.open, { feedbackForm: form });
});

beforeEach(() => { web.session = null; });

afterAll(async () => {
  await prisma.organisation.deleteMany({ where: { id: organisationId } });
  await prisma.user.deleteMany({ where: { id: { in: Object.values(users).filter(Boolean) } } });
  await prisma.$disconnect();
});

describe.sequential("feedback access", () => {
  it("keeps an invite-only event's form from anyone but a signed-in invited guest on the web", async () => {
    await expect(page(slugs.invite)).rejects.toThrow("not-found");
    await expect(submitFeedback(answer(slugs.invite))).resolves.toEqual({ ok: false, error: "Feedback is not open for this event." });
    web.session = { user: { id: users.stranger } };
    await expect(page(slugs.invite)).rejects.toThrow("not-found");
    await expect(submitFeedback(answer(slugs.invite))).resolves.toEqual({ ok: false, error: "Feedback is not open for this event." });

    web.session = { user: { id: users.invited } };
    await expect(page(slugs.invite)).resolves.toMatchObject({ eventSlug: slugs.invite });
    await expect(submitFeedback(answer(slugs.invite))).resolves.toEqual({ ok: true, data: { certificateToken: null } });
  });

  it("opens nothing for an event whose website is unreleased", async () => {
    web.session = { user: { id: users.invited } };
    await expect(page(slugs.unreleased)).rejects.toThrow("not-found");
    await expect(submitFeedback(answer(slugs.unreleased))).resolves.toEqual({ ok: false, error: "Feedback is not open for this event." });
    expect((await appForm(slugs.unreleased)).status).toBe(404);
    expect((await appSubmit(slugs.unreleased)).status).toBe(400);
  });

  it("applies the same rule to the app, which may sign in so an invited guest can answer", async () => {
    expect((await appForm(slugs.invite)).status).toBe(404);
    expect((await appSubmit(slugs.invite)).status).toBe(400);
    const stranger = await appSession(users.stranger);
    expect((await appForm(slugs.invite, stranger)).status).toBe(404);
    expect((await appSubmit(slugs.invite, stranger)).status).toBe(400);

    const invited = await appSession(users.invited);
    expect((await appForm(slugs.invite, invited)).status).toBe(200);
    const submitted = await appSubmit(slugs.invite, invited);
    expect(submitted.status).toBe(200);
    await expect(submitted.json()).resolves.toEqual({ ok: true, data: { certificateToken: null } });
    // A bearer that doesn't sign in is refused, never treated as anonymous.
    expect((await appSubmit(slugs.open, "not-a-token")).status).toBe(401);
  });

  it("keeps a public, released event's form open to everyone", async () => {
    await expect(page(slugs.open)).resolves.toMatchObject({ eventSlug: slugs.open });
    await expect(submitFeedback(answer(slugs.open))).resolves.toEqual({ ok: true, data: { certificateToken: null } });
    expect((await appForm(slugs.open)).status).toBe(200);
  });
});
