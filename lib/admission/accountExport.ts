import "server-only";

import { prisma } from "@/lib/db";
import { admissionKeyHash } from "./registration";

/*
 * The applications part of the personal data export (/api/exports/account,
 * docs/ADMISSION.md "Retention"): every application the account is in, also
 * withdrawn and detached ones found by its hashed keys, with status, stage
 * and the account's own answer revisions. Never reviews, scores or reviewers.
 */

const LIMIT = 200;

export async function loadAccountApplications(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
  if (!user) return [];
  const keys = [admissionKeyHash(`user:${userId}`), ...(user.email ? [admissionKeyHash(`guest:${user.email.trim().toLowerCase()}`)] : [])];
  const own = await prisma.rSVP.findMany({ where: { userId, eventId: { not: null }, isCrew: false }, select: { id: true, teamId: true }, take: LIMIT });
  const apps = await prisma.admissionApplication.findMany({
    where: {
      OR: [
        { rsvpId: { in: own.map((rsvp) => rsvp.id) } },
        { teamId: { in: own.flatMap((rsvp) => (rsvp.teamId ? [rsvp.teamId] : [])) } },
        { applicantKeys: { hasSome: keys } },
      ],
    },
    select: {
      id: true, status: true, rsvpId: true, teamId: true, submittedAt: true, offeredAt: true, respondBy: true, subjectName: true,
      event: { select: { title: true, organisation: { select: { name: true } } } },
      currentStage: { select: { name: true } },
      team: { select: { name: true } },
      answerRevisions: { where: { OR: [{ rsvpId: { in: own.map((rsvp) => rsvp.id) } }, { personKey: { in: keys } }] }, select: { answersRevision: true, answers: true, createdAt: true }, orderBy: { createdAt: "asc" } },
    },
    orderBy: { submittedAt: "desc" },
    take: LIMIT,
  });
  return apps.map((app) => ({
    event: app.event.title,
    organisation: app.event.organisation.name,
    status: app.status,
    stage: app.currentStage?.name ?? null,
    team: app.team?.name ?? null,
    submittedAt: app.submittedAt.toISOString(),
    offeredAt: app.offeredAt?.toISOString() ?? null,
    respondBy: app.respondBy?.toISOString() ?? null,
    // The account's own earlier answers only (its registrations', or by its hashed person key once they are gone).
    earlierAnswers: app.answerRevisions.map((revision) => ({ revision: revision.answersRevision, replacedAt: revision.createdAt.toISOString(), answers: revision.answers })),
  }));
}
