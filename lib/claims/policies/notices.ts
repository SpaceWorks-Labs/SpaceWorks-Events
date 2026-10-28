import "server-only";

import { EventStatus, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { REIMBURSEMENT_AVAILABLE_KIND, type ReimbursementAvailablePayload } from "@/lib/outbox/reimbursement";
import { eligibleRegistrationIds } from "./eligibility";

/**
 * The beat's "reimbursement available" pass (docs/FINANCE.md): for each open
 * policy whose organiser turned the email on, queue it once for every
 * registration that qualifies now and hasn't been told (ReimbursementNotice,
 * unique per policy and registration). A person qualifies later, for
 * example when finalists are published or their team takes part in a
 * mentoring round, and is told on a later pass. Each pass takes the policies
 * checked longest ago (`noticesCheckedAt`), so none starves behind others,
 * and handles each under its own row lock, so two beats never queue the
 * same person twice. A message dropped at delivery clears its notice
 * (lib/outbox/reimbursement.ts), so the person can be told later.
 */

export const POLICIES_PER_PASS = 50;
const PEOPLE_PER_POLICY = 200;

export async function queueReimbursementNotices(now = new Date()) {
  const policies = await prisma.reimbursementPolicy.findMany({
    where: {
      active: true,
      notifyWhenAvailable: true,
      event: { status: EventStatus.PUBLISHED },
      AND: [{ OR: [{ claimOpensAt: null }, { claimOpensAt: { lte: now } }] }, { OR: [{ claimClosesAt: null }, { claimClosesAt: { gt: now } }] }],
    },
    orderBy: [{ noticesCheckedAt: { sort: "asc", nulls: "first" } }, { id: "asc" }],
    take: POLICIES_PER_PASS,
    select: { id: true },
  });
  let queued = 0;
  for (const { id } of policies) queued += await prisma.$transaction((tx) => queueForPolicy(tx, id, now));
  return { queued, policies: policies.length };
}

async function queueForPolicy(tx: Prisma.TransactionClient, policyId: string, now: Date) {
  await tx.$queryRaw`SELECT "id" FROM "ReimbursementPolicy" WHERE "id" = ${policyId} FOR UPDATE`;
  const policy = await tx.reimbursementPolicy.findUnique({ where: { id: policyId }, include: { event: { select: { organisationId: true } } } });
  if (!policy) return 0;
  await tx.reimbursementPolicy.update({ where: { id: policyId }, data: { noticesCheckedAt: now } });
  if (!policy.active || !policy.notifyWhenAvailable) return 0;
  const ids = await eligibleRegistrationIds(tx, policy.eventId, policy, PEOPLE_PER_POLICY, { reimbursementNotices: { none: { policyId } } });
  if (ids.length === 0) return 0;
  const people = await tx.rSVP.findMany({ where: { id: { in: ids } }, select: { id: true, guestEmail: true, user: { select: { email: true } } } });
  const payloads: ReimbursementAvailablePayload[] = [];
  for (const person of people) {
    const to = (person.user?.email?.trim() || person.guestEmail?.trim() || "").toLowerCase();
    if (to) payloads.push({ to, policyId, rsvpId: person.id, organisationId: policy.event.organisationId });
  }
  // Everyone found is recorded, even without an address, so they aren't looked at again.
  await tx.reimbursementNotice.createMany({ data: ids.map((rsvpId) => ({ policyId, rsvpId })), skipDuplicates: true });
  if (payloads.length) await tx.outboxMessage.createMany({ data: payloads.map((payload) => ({ kind: REIMBURSEMENT_AVAILABLE_KIND, payload: payload as Prisma.InputJsonValue })) });
  return payloads.length;
}
