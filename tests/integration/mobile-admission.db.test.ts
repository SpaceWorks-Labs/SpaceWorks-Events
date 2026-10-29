import { AdmissionStatus, EventPermission } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/*
 * Applications through the mobile API (docs/ADMISSION.md, docs/MOBILE_API.md):
 * an applicant reads and answers their own application with the app session
 * (free and paid, never confirmed unpaid), edits answers while allowed;
 * reviewers see only their own assignments, blind where the stage is, behind
 * the staff authenticator; organisers get counts; the old guest decisions
 * answer ADMISSION_MANAGED; nothing crosses organisations.
 */

process.env.REDIS_URL = "";
process.env.TRUSTED_PROXY_IP_HEADER = "x-real-ip";
process.env.MFA_ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString("base64");

vi.mock("next-auth", () => ({ default: () => ({ auth: async () => null, handlers: {}, signIn: vi.fn(), signOut: vi.fn() }), CredentialsSignin: class extends Error {} }));
vi.mock("next-auth/providers/google", () => ({ default: vi.fn() }));
vi.mock("next-auth/providers/credentials", () => ({ default: vi.fn() }));
vi.mock("@/lib/authAdapter", () => ({ authAdapter: {} }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-real-ip": `198.18.2.${Math.floor(Math.random() * 250)}` }), cookies: async () => ({ get: () => undefined, set: vi.fn(), delete: vi.fn() }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/outboxWorker", () => ({ startOutboxWorker: vi.fn() }));

import { prisma } from "@/lib/db";
import { appSession, get, keyed, params, post, unkeyed } from "../helpers/mobileApi";
import { apply, createAdmissionEvent, decide, grantReviewers, paid, people, setUpAdmission, tearDownAdmission } from "./helpers/admission";
import { GET as myApplication } from "@/app/api/mobile/v1/me/registrations/[rsvpId]/application/route";
import { POST as respond } from "@/app/api/mobile/v1/me/registrations/[rsvpId]/application/respond/route";
import { PUT as saveAnswers } from "@/app/api/mobile/v1/me/registrations/[rsvpId]/application/answers/route";
import { GET as summary } from "@/app/api/mobile/v1/orgs/[orgSlug]/events/[eventId]/applications/summary/route";
import { GET as reviewQueue } from "@/app/api/mobile/v1/orgs/[orgSlug]/events/[eventId]/applications/reviews/route";
import { GET as reviewItem, POST as submitReview } from "@/app/api/mobile/v1/orgs/[orgSlug]/events/[eventId]/applications/reviews/[assignmentId]/route";
import { POST as recuse } from "@/app/api/mobile/v1/orgs/[orgSlug]/events/[eventId]/applications/reviews/[assignmentId]/recuse/route";
import { POST as approveGuest } from "@/app/api/mobile/v1/orgs/[orgSlug]/events/[eventId]/guests/[rsvpId]/approve/route";
import { GET as eventDetail } from "@/app/api/mobile/v1/orgs/[orgSlug]/events/[eventId]/route";
import { GET as publicEvent } from "@/app/api/mobile/v1/public/events/[orgSlug]/[eventSlug]/route";

beforeAll(() => setUpAdmission("Mobile applications"));
afterAll(() => tearDownAdmission());

const json = async (response: Response) => ({ status: response.status, body: await response.json() });
const mine = (rsvpId: string) => params({ rsvpId });
let key = 0;
const nextKey = () => `key-${paid.suffix.slice(0, 8)}-${(key += 1)}`;

describe.sequential("applications through the mobile API", () => {
  it("lets an applicant answer a free offer and edit answers, only for their own registration", async () => {
    const { event, ctx } = await createAdmissionEvent();
    await prisma.eventRegistrationForm.create({ data: { eventId: event.id, fields: { create: [{ key: "why", label: "Why?", type: "TEXT" }] } } });
    const a = await apply(event, "mobile-free", { userId: people.r1 });
    const token = await appSession(people.r1);
    const stranger = await appSession(people.outsider);
    expect((await myApplication(get("/x", stranger), mine(a.rsvp.id))).status).toBe(404);

    const before = await json(await myApplication(get("/x", token), mine(a.rsvp.id)));
    expect(before.body.data.application).toMatchObject({ status: "IN_REVIEW", stage: { name: "Review", position: 1 }, actions: ["withdraw"], paid: false, answers: [{ key: "why", value: "" }] });
    expect(JSON.stringify(before.body)).not.toContain(a.token);
    const edited = await json(await saveAnswers(keyed("/x", { answers: { why: "To learn" } }, token, nextKey(), "PUT"), mine(a.rsvp.id)));
    expect(edited.body.data.application.answers[0]).toMatchObject({ value: "To learn" });

    await decide(ctx, [a.application.id], "ACCEPT");
    const offered = await json(await myApplication(get("/x", token), mine(a.rsvp.id)));
    expect(offered.body.data.application).toMatchObject({ status: "OFFERED", actions: ["accept", "decline", "withdraw"], respondBy: expect.any(String), answers: null });
    expect((await respond(unkeyed("/x", { response: "accept" }, token), mine(a.rsvp.id))).status).toBe(400);
    const accept = keyed("/x", { response: "accept" }, token, `accept-${paid.suffix}`);
    expect(await json(await respond(accept, mine(a.rsvp.id)))).toEqual({ status: 200, body: { ok: true, data: { status: "ACCEPTED", paying: false, checkoutUrl: null } } });
    const replay = await respond(keyed("/x", { response: "accept" }, token, `accept-${paid.suffix}`), mine(a.rsvp.id));
    expect(replay.headers.get("Idempotent-Replayed")).toBe("true");
    expect(await prisma.rSVP.findUniqueOrThrow({ where: { id: a.rsvp.id } })).toMatchObject({ status: "CONFIRMED" });
  });

  it("holds a paid place while it is paid and returns the checkout page, never confirming it unpaid", async () => {
    const { event, ticket, ctx } = await createAdmissionEvent({ price: 49900 });
    const a = await apply(event, "mobile-paid", { ticketTypeId: ticket!.id, userId: people.r2 });
    const token = await appSession(people.r2);
    await decide(ctx, [a.application.id], "ACCEPT");
    const accepted = await json(await respond(keyed("/x", { response: "accept" }, token, nextKey()), mine(a.rsvp.id)));
    expect(accepted.body.data).toMatchObject({ status: "OFFERED", paying: true, checkoutUrl: expect.stringMatching(/^https:/) });
    expect(await prisma.rSVP.findUniqueOrThrow({ where: { id: a.rsvp.id } })).toMatchObject({ status: "PENDING_PAYMENT" });
    const now = await json(await myApplication(get("/x", token), mine(a.rsvp.id)));
    expect(now.body.data.application).toMatchObject({ status: "OFFERED", paying: true, paid: true, actions: [] });
    const declined = await json(await respond(keyed("/x", { response: "decline" }, token, nextKey()), mine(a.rsvp.id)));
    expect(declined).toMatchObject({ status: 409, body: { ok: false } });
  });

  it("shows reviewers only their own work, blind where the stage is, and organisers counts", async () => {
    const { event, ctx } = await createAdmissionEvent();
    await grantReviewers(event, people.r1, people.r2);
    await prisma.admissionStage.updateMany({ where: { eventId: event.id }, data: { blindReview: true, status: "OPEN" } });
    const a = await apply(event, "reviewed");
    const stage = await prisma.admissionStage.findFirstOrThrow({ where: { eventId: event.id } });
    const mineToReview = await prisma.admissionReviewAssignment.create({ data: { stageId: stage.id, applicationId: a.application.id, reviewerUserId: people.r1 } });
    const r1 = await appSession(people.r1);
    const r2 = await appSession(people.r2);
    const at = <T extends Record<string, string>>(extra?: T) => params({ orgSlug: paid.orgSlug, eventId: event.id, ...(extra ?? {}) } as { orgSlug: string; eventId: string } & T);

    const queue = await json(await reviewQueue(get("/x", r1), at()));
    expect(queue.body.data.reviews).toEqual([expect.objectContaining({ assignmentId: mineToReview.id, label: "Application 1", stageOpen: true })]);
    const item = await json(await reviewItem(get("/x", r1), at({ assignmentId: mineToReview.id })));
    expect(item.body.data).toMatchObject({ blind: true, teamName: null, people: [{ name: "Applicant 1", email: null }] });
    expect(JSON.stringify(item.body)).not.toContain(a.email);
    expect((await reviewItem(get("/x", r2), at({ assignmentId: mineToReview.id }))).status).toBe(404);
    expect((await reviewQueue(get("/x", await appSession(people.outsider)), at())).status).toBe(404);
    // A reviewer isn't an organiser: no event routes, no summary.
    expect((await summary(get("/x", r1), at())).status).toBe(404);

    const submitted = await json(await submitReview(keyed("/x", { answersRevision: item.body.data.answersRevision, scores: { overall: 4 }, notes: "Good" }, r1, nextKey()), at({ assignmentId: mineToReview.id })));
    expect(submitted.body.data).toEqual({ assignmentId: mineToReview.id, outcome: "SUBMITTED", replaced: null });
    const b = await apply(event, "recused");
    const other = await prisma.admissionReviewAssignment.create({ data: { stageId: stage.id, applicationId: b.application.id, reviewerUserId: people.r1 } });
    const stepped = await json(await recuse(keyed("/x", {}, r1, nextKey()), at({ assignmentId: other.id })));
    expect(stepped.body.data).toEqual({ assignmentId: other.id, outcome: "RECUSED", replaced: true });

    const owner = await appSession(people.owner);
    const counts = await json(await summary(get("/x", owner), at()));
    expect(counts.body.data).toMatchObject({ enabled: true, counts: { total: 2, byStatus: { IN_REVIEW: 2 } }, stages: [{ position: 1, inReview: 2 }] });
    const detail = await json(await eventDetail(get("/x", owner), at()));
    expect(detail.body.data.counts.applications).toMatchObject({ total: 2 });
    expect(detail.body.data.myPermissions).toMatchObject({ manageApplications: true, reviewApplications: true });
    const shown = await json(await publicEvent(get("/x"), params({ orgSlug: paid.orgSlug, eventSlug: event.slug })));
    expect(shown.body.data.registration.takesApplications).toBe(true);
    await decide(ctx, [a.application.id], "WAITLIST");
  });

  it("asks reviewers for their authenticator, keeps organisations apart, and refuses the old guest decisions", async () => {
    const { event } = await createAdmissionEvent();
    await prisma.eventCollaborator.create({ data: { eventId: event.id, userId: people.r3, permissions: [EventPermission.REVIEW_APPLICATIONS] } });
    const a = await apply(event, "old-route");
    const at = params({ orgSlug: paid.orgSlug, eventId: event.id });
    vi.stubEnv("STAFF_MFA_REQUIRED", "true");
    try {
      const unverified = await appSession(people.r3, { mfa: false });
      expect(await json(await reviewQueue(get("/x", unverified), at))).toMatchObject({ body: { error: { code: expect.stringMatching(/^STAFF_MFA/) } } });
    } finally {
      vi.stubEnv("STAFF_MFA_REQUIRED", "false");
    }
    const other = await prisma.organisation.create({ data: { name: "Elsewhere", slug: `mob-adm-other-${paid.suffix}` } });
    try {
      await prisma.membership.create({ data: { userId: people.outsider, organisationId: other.id, role: "OWNER" } });
      const outsider = await appSession(people.outsider);
      expect((await summary(get("/x", outsider), params({ orgSlug: other.slug, eventId: event.id }))).status).toBe(404);
      expect((await reviewQueue(get("/x", outsider), params({ orgSlug: other.slug, eventId: event.id }))).status).toBe(404);
    } finally {
      await prisma.organisation.delete({ where: { id: other.id } });
    }
    const owner = await appSession(people.owner);
    const refused = await json(await approveGuest(post("/x", {}, owner), params({ orgSlug: paid.orgSlug, eventId: event.id, rsvpId: a.rsvp.id })));
    expect(refused).toMatchObject({ status: 409, body: { ok: false, error: { code: "ADMISSION_MANAGED" } } });
    expect((await prisma.admissionApplication.findUniqueOrThrow({ where: { id: a.application.id } })).status).toBe(AdmissionStatus.IN_REVIEW);
  });
});
