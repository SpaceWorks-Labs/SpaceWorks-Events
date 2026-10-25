import "server-only";

/** Judging → Judges: per-judge progress counted from aggregates. */

import { SubmissionStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import type { JudgingOrganiserContext } from "@/lib/judgingAccess";
import { conflictKeysFor, type EligibleJudgeDto, hasConflictOfInterest, listEligibleJudges } from "./judges";

export type JudgeProgressRowDto = EligibleJudgeDto & {
  /** Submissions this judge can see (assignment rule and conflicts applied); null for an organiser who hasn't judged yet. */
  visible: number | null;
  /** Reviews that count in the scores (see loadJudgingResults). */
  reviewsSubmitted: number;
  /** Assignments on any project of the event, whatever its status. */
  assigned: number;
};

function countBy(rows: Array<{ judgeUserId: string; _count: { _all: number } }>): Map<string, number> {
  return new Map(rows.map((row) => [row.judgeUserId, row._count._all]));
}

/**
 * Judging → Judges: one row per eligible judge (JUDGE collaborators, then
 * organisation owners and admins), plus anyone else whose review is on record
 * (a revoked judge: listed with no counted reviews). Counts come from
 * aggregates, not from loading every score: an eligible judge sees every
 * SUBMITTED project (or their assigned ones), less entrants their own
 * account is registered on; a review counts when it is submitted, on a
 * SUBMITTED project, and not such an entrant's. Organisers show "not judging
 * yet" (visible null) until they review, score, or are assigned.
 */
export async function loadJudgeProgress(ctx: JudgingOrganiserContext): Promise<JudgeProgressRowDto[] | null> {
  const event = await prisma.event.findFirst({ where: { id: ctx.eventId, organisationId: ctx.organisationId }, select: { id: true, judgesSeeAll: true } });
  if (!event) return null;
  const submittedOnly = { eventId: event.id, status: SubmissionStatus.SUBMITTED };
  const [eligible, reviewAuthors, scorers, assignedAll, assignedSubmitted, countedReviews, submittedCount] = await Promise.all([
    listEligibleJudges(ctx),
    prisma.judgeReview.groupBy({ by: ["judgeUserId"], where: { submission: { eventId: event.id } }, _count: { _all: true }, orderBy: { judgeUserId: "asc" } }),
    prisma.judgeScore.groupBy({ by: ["judgeUserId"], where: { submission: { eventId: event.id } }, _count: { _all: true }, orderBy: { judgeUserId: "asc" } }),
    prisma.judgeAssignment.groupBy({ by: ["judgeUserId"], where: { eventId: event.id, submission: { eventId: event.id } }, _count: { _all: true }, orderBy: { judgeUserId: "asc" } }),
    prisma.judgeAssignment.groupBy({ by: ["judgeUserId"], where: { eventId: event.id, submission: submittedOnly }, _count: { _all: true }, orderBy: { judgeUserId: "asc" } }),
    prisma.judgeReview.groupBy({ by: ["judgeUserId"], where: { submittedAt: { not: null }, submission: submittedOnly }, _count: { _all: true }, orderBy: { judgeUserId: "asc" } }),
    prisma.submission.count({ where: submittedOnly }),
  ]);
  const active = new Set([...reviewAuthors, ...scorers, ...assignedAll].map((row) => row.judgeUserId));
  const eligibleIds = new Set(eligible.map((judge) => judge.userId));
  const formerIds = reviewAuthors.map((row) => row.judgeUserId).filter((id) => !eligibleIds.has(id));
  const counted = new Set([...eligible.filter((judge) => judge.kind === "judge" || active.has(judge.userId)).map((judge) => judge.userId)]);

  // Conflicts of interest are rare and small (a judge's own registrations),
  // so the SUBMITTED projects they touch are read row by row.
  const conflicts = await conflictKeysFor(prisma, event.id, [...counted]);
  const teamIds = [...conflicts.values()].flatMap((keys) => [...keys.teamIds]);
  const rsvpIds = [...conflicts.values()].flatMap((keys) => [...keys.rsvpIds]);
  const conflicted =
    teamIds.length + rsvpIds.length === 0
      ? []
      : await prisma.submission.findMany({
          where: { ...submittedOnly, OR: [...(teamIds.length ? [{ teamId: { in: teamIds } }] : []), ...(rsvpIds.length ? [{ rsvpId: { in: rsvpIds } }] : [])] },
          select: {
            teamId: true,
            rsvpId: true,
            assignments: { where: { judgeUserId: { in: [...counted] } }, select: { judgeUserId: true } },
            reviews: { where: { judgeUserId: { in: [...counted] }, submittedAt: { not: null } }, select: { judgeUserId: true } },
          },
        });
  const formerNames =
    formerIds.length === 0 ? new Map<string, string>() : new Map((await prisma.user.findMany({ where: { id: { in: formerIds } }, select: { id: true, name: true } })).map((user) => [user.id, user.name?.trim() || "Judge"]));

  const assignedTotal = countBy(assignedAll);
  const assignedVisible = countBy(assignedSubmitted);
  const reviewsCounted = countBy(countedReviews);
  const progress = (userId: string) => {
    const own = conflicted.filter((row) => hasConflictOfInterest(row, conflicts.get(userId)));
    const hidden = own.filter((row) => event.judgesSeeAll || row.assignments.some((assignment) => assignment.judgeUserId === userId)).length;
    const hiddenReviews = own.filter((row) => row.reviews.some((review) => review.judgeUserId === userId)).length;
    return {
      visible: (event.judgesSeeAll ? submittedCount : assignedVisible.get(userId) ?? 0) - hidden,
      reviewsSubmitted: (reviewsCounted.get(userId) ?? 0) - hiddenReviews,
    };
  };
  const rows: JudgeProgressRowDto[] = eligible.map((judge) =>
    counted.has(judge.userId)
      ? { ...judge, ...progress(judge.userId), assigned: assignedTotal.get(judge.userId) ?? 0 }
      : { ...judge, visible: null, reviewsSubmitted: 0, assigned: assignedTotal.get(judge.userId) ?? 0 },
  );
  // A judge whose grant was revoked after reviewing stays listed for the record; their reviews no longer count.
  for (const userId of formerIds) {
    rows.push({ userId, name: formerNames.get(userId) ?? "Judge", email: null, kind: "judge", visible: 0, reviewsSubmitted: 0, assigned: assignedTotal.get(userId) ?? 0 });
  }
  return rows;
}
