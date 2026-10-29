import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/*
 * Every editor of an application's answers follows the applicant's rules
 * (docs/ADMISSION.md): the organiser's Edit registration and the buyer's
 * order page keep the replaced answers, raise the answers revision (so a
 * reviewer still holding the old answers is refused as stale) and refuse
 * changes once a decision has locked the answers. A name-only edit writes
 * no revision.
 */

const identity = vi.hoisted(() => ({ id: "" }));
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => (identity.id ? { user: { id: identity.id } } : null)) }));
vi.mock("@/lib/actionRateLimit", () => ({ isActionRateLimited: async () => false }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn(), updateTag: vi.fn() }));

import type { Event } from "@prisma/client";
import { prisma } from "@/lib/db";
import { submitApplicationReview } from "@/app/actions/admission-applicant";
import { updateOrderAttendee } from "@/app/actions/orders";
import { updateRsvpRegistration } from "@/app/actions/rsvp-admin";
import { STALE_ANSWERS } from "@/lib/admission/reviews";
import { appOf, apply, createAdmissionEvent, decide, grantReviewers, paid, people, setUpAdmission, tearDownAdmission } from "./helpers/admission";

beforeAll(() => setUpAdmission("Answer editors"));
afterAll(() => tearDownAdmission());

async function as<T>(userId: string, run: () => Promise<T>) {
  identity.id = userId;
  try { return await run(); } finally { identity.id = ""; }
}

const askWhy = (event: Event) => prisma.eventRegistrationForm.create({ data: { eventId: event.id, fields: { create: [{ key: "why", label: "Why?", type: "TEXT", required: false }] } } });

/** Reviewer r1 is assigned the application while its answers are at revision 1. */
async function assigned(event: Event, applicationId: string) {
  const stage = await prisma.admissionStage.findFirstOrThrow({ where: { eventId: event.id } });
  return prisma.admissionReviewAssignment.create({ data: { stageId: stage.id, applicationId, reviewerUserId: people.r1 } });
}

const review = (event: Event, assignmentId: string, answersRevision: number) => as(people.r1, () => submitApplicationReview({ organisationSlug: paid.orgSlug, eventId: event.id, assignmentId, answersRevision, scores: { overall: 3 }, notes: "" }));
const organiserEdit = (event: Event, rsvpId: string, answers: Record<string, string>, name = "Organiser Edit") => as(people.owner, () => updateRsvpRegistration({ organisationSlug: paid.orgSlug, eventId: event.id, rsvpId, name, answers }));
const LOCKED = "This application's answers can't change any more: a decision has been made.";

describe.sequential("application answers through every editor", () => {
  it("the organiser's registration editor raises the revision, so a stale review is refused", async () => {
    const { event } = await createAdmissionEvent();
    await askWhy(event);
    await grantReviewers(event, people.r1);
    const a = await apply(event, "organiser-edit");
    const onA = await assigned(event, a.application.id);

    expect(await organiserEdit(event, a.rsvp.id, { why: "Changed by the organiser" })).toEqual({ ok: true });
    expect(await appOf(a.application.id)).toMatchObject({ answersRevision: 2, version: a.application.version + 1 });
    expect(await prisma.admissionAnswerRevision.count({ where: { applicationId: a.application.id } })).toBe(1);
    expect(await review(event, onA.id, 1)).toEqual({ ok: false, error: STALE_ANSWERS });

    // The same answers with a new name: no new revision.
    expect(await organiserEdit(event, a.rsvp.id, { why: "Changed by the organiser" }, "Renamed Applicant")).toEqual({ ok: true });
    expect(await appOf(a.application.id)).toMatchObject({ answersRevision: 2 });
    expect(await review(event, onA.id, 2)).toMatchObject({ ok: true });
  });

  it("the buyer's order page raises the revision, so a stale review is refused", async () => {
    const { event, ticket } = await createAdmissionEvent({ price: 49900 });
    await askWhy(event);
    await grantReviewers(event, people.r1);
    const a = await apply(event, "buyer-edit", { ticketTypeId: ticket!.id });
    const order = await prisma.order.findUniqueOrThrow({ where: { id: a.rsvp.orderId! } });
    const onA = await assigned(event, a.application.id);

    expect(await updateOrderAttendee({ orderToken: order.accessToken, rsvpId: a.rsvp.id, name: "Buyer Person", answers: { why: "Changed by the buyer" } })).toEqual({ ok: true });
    expect(await appOf(a.application.id)).toMatchObject({ answersRevision: 2 });
    expect(await prisma.rsvpAnswer.findFirstOrThrow({ where: { rsvpId: a.rsvp.id } })).toMatchObject({ valueText: "Changed by the buyer" });
    expect(await review(event, onA.id, 1)).toEqual({ ok: false, error: STALE_ANSWERS });
  });

  it("refuses answer changes through either editor once a decision locks them", async () => {
    const { event, ticket, ctx } = await createAdmissionEvent({ price: 49900 });
    await askWhy(event);
    const a = await apply(event, "locked-edit", { ticketTypeId: ticket!.id });
    const order = await prisma.order.findUniqueOrThrow({ where: { id: a.rsvp.orderId! } });
    expect(await organiserEdit(event, a.rsvp.id, { why: "Before the decision" })).toEqual({ ok: true });
    await decide(ctx, [a.application.id], "WAITLIST");
    const decided = await appOf(a.application.id);
    expect(decided.answersLockedAt).not.toBeNull();

    expect(await organiserEdit(event, a.rsvp.id, { why: "After the decision" })).toEqual({ ok: false, error: LOCKED });
    expect(await updateOrderAttendee({ orderToken: order.accessToken, rsvpId: a.rsvp.id, name: "Buyer Person", answers: { why: "After the decision" } })).toEqual({ ok: false, error: LOCKED });
    expect(await prisma.rsvpAnswer.findFirstOrThrow({ where: { rsvpId: a.rsvp.id } })).toMatchObject({ valueText: "Before the decision" });
    expect(await appOf(a.application.id)).toMatchObject({ answersRevision: decided.answersRevision, version: decided.version });
    // A name correction with the same answers still goes through.
    expect(await organiserEdit(event, a.rsvp.id, { why: "Before the decision" }, "Corrected Name")).toEqual({ ok: true });
  });
});
