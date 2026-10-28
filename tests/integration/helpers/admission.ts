import { randomUUID } from "node:crypto";
import { AdmissionDecisionOutcome, EventPermission, EventPrivacyType, EventStatus, MembershipRole, RegistrationMode, SoloPolicy, TeamTicketMode, type Event } from "@prisma/client";
import { expect } from "vitest";
import { prisma } from "@/lib/db";
import { submitRsvpCore } from "@/lib/rsvpCore";
import type { AdmissionContext } from "@/lib/admission/access";
import { draftDecisions, releaseDraftBatch } from "@/lib/admission/decisions";
import { setAdmissionEnabled } from "@/lib/admission/settings";
import type { TeamRegistrationIntent } from "@/lib/validators";
import { paid, setUpPaidOrg, tearDownPaidOrg } from "./paidOrg";

/*
 * Fixture for the admission suites (docs/ADMISSION.md). Each suite gets its
 * own paid-capable organisation (the fake Razorpay of paidOrg.ts), an owner,
 * and reviewers. Call setUpAdmission / tearDownAdmission from beforeAll /
 * afterAll after mocking `@/lib/auth`.
 */

export const people = { owner: "", r1: "", r2: "", r3: "", outsider: "" };
let sequence = 0;

export async function setUpAdmission(name: string) {
  await setUpPaidOrg(name);
  for (const key of Object.keys(people) as Array<keyof typeof people>) {
    const user = await prisma.user.create({ data: { email: `${key}-${paid.suffix}@example.test`, name: `${key} ${paid.suffix.slice(0, 4)}`, emailVerified: new Date() } });
    people[key] = user.id;
  }
  await prisma.membership.create({ data: { userId: people.owner, organisationId: paid.organisationId, role: MembershipRole.OWNER } });
}

export async function tearDownAdmission() {
  await prisma.organisation.deleteMany({ where: { id: paid.organisationId } });
  await prisma.user.deleteMany({ where: { id: { in: Object.values(people).filter(Boolean) } } });
  await tearDownPaidOrg();
}

export type EventOptions = { team?: boolean; price?: number; capacity?: number | null; offerCapacity?: number | null; minTeam?: number; teamMode?: TeamTicketMode; typeCapacity?: number; submissions?: boolean };

/** A published approval-only event with applications on (and a ticket type when `price` is given). */
export async function createAdmissionEvent(options: EventOptions = {}) {
  sequence += 1;
  const event = await prisma.event.create({ data: {
    organisationId: paid.organisationId, title: `Applications ${sequence}`, slug: `apply-${paid.suffix}-${sequence}`, currency: "INR",
    startDateTime: new Date("2035-01-01T10:00:00.000Z"), endDateTime: new Date("2035-01-02T10:00:00.000Z"), timezone: "UTC",
    capacity: options.capacity ?? null, status: EventStatus.PUBLISHED, privacyType: EventPrivacyType.APPROVAL_REQUIRED,
    submissionsEnabled: options.submissions ?? false,
    ...(options.team ? { registrationMode: RegistrationMode.TEAM, teamMaxSize: 4, teamMinSize: options.minTeam ?? null, soloPolicy: SoloPolicy.SOLO_ALLOWED, teamTicketMode: options.teamMode ?? TeamTicketMode.PER_TEAM } : {}),
    page: { create: { isPublished: true } },
  } });
  const ticket = options.price === undefined ? null : await prisma.ticketType.create({ data: { eventId: event.id, name: "Entry", priceMinor: BigInt(options.price), maxPerOrder: 1, capacity: options.typeCapacity ?? null } });
  const ctx = organiserCtx(event);
  expect(await setAdmissionEnabled(ctx, true)).toEqual({ ok: true });
  if (options.offerCapacity !== undefined) await prisma.event.update({ where: { id: event.id }, data: { admissionOfferCapacity: options.offerCapacity } });
  return { event: await prisma.event.findUniqueOrThrow({ where: { id: event.id } }), ticket, ctx };
}

export function organiserCtx(event: Event, userId = people.owner): AdmissionContext {
  return { userId, organisationId: event.organisationId, orgSlug: paid.orgSlug, eventId: event.id, eventSlug: event.slug, isAdmin: userId === people.owner };
}

export async function grantReviewers(event: Event, ...userIds: string[]) {
  for (const userId of userIds) await prisma.eventCollaborator.create({ data: { eventId: event.id, userId, permissions: [EventPermission.REVIEW_APPLICATIONS] } });
}

/** Register (apply) as a guest; returns the RSVP, its ticket token and the application. */
export async function apply(event: Event, label: string, options: { ticketTypeId?: string; team?: TeamRegistrationIntent; userId?: string } = {}) {
  sequence += 1;
  const email = `${label}-${sequence}-${paid.suffix}@example.test`;
  const result = await submitRsvpCore(
    { orgSlug: paid.orgSlug, eventSlug: event.slug, guestEmail: email, name: `${label} Person`, answers: {}, ...(options.ticketTypeId ? { items: [{ ticketTypeId: options.ticketTypeId, quantity: 1 }] } : {}) },
    { userId: null, ...(options.team ? { team: options.team } : {}) },
  );
  if (!result.ok || !result.data) throw new Error(`registration failed: ${result.ok ? "no data" : result.error}`);
  const rsvp = await prisma.rSVP.findUniqueOrThrow({ where: { checkInToken: result.data.ticketToken } });
  if (options.userId) await prisma.rSVP.update({ where: { id: rsvp.id }, data: { userId: options.userId } });
  const application = await prisma.admissionApplication.findFirstOrThrow({ where: rsvp.teamId ? { teamId: rsvp.teamId } : { rsvpId: rsvp.id } });
  return { rsvp, token: result.data.ticketToken, email, application };
}

export async function decide(ctx: AdmissionContext, applicationIds: string[], outcome: AdmissionDecisionOutcome, overrideReason = "Testing without reviews") {
  const drafted = await draftDecisions(ctx, { applicationIds, outcome, overrideReason });
  if (!drafted.ok) throw new Error(drafted.error);
  const released = await releaseDraftBatch(ctx);
  if (!released.ok) throw new Error(released.error);
  return released.data;
}

export const appOf = (id: string) => prisma.admissionApplication.findUniqueOrThrow({ where: { id } });
export const rsvpOf = (id: string) => prisma.rSVP.findUniqueOrThrow({ where: { id } });
export const noticesFor = (applicationId: string, notice: string) => prisma.outboxMessage.count({ where: { kind: "admission-notice", AND: [{ payload: { path: ["applicationId"], equals: applicationId } }, { payload: { path: ["notice"], equals: notice } }] } });

export { paid };
