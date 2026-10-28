import { SubmissionStatus } from "@prisma/client";
import { NOBODY, no, yes, type EligibilityResolver } from "./types";

/** Projects that left the competition no longer qualify their entrants. */
const OUT = [SubmissionStatus.WITHDRAWN, SubmissionStatus.DISQUALIFIED];

/**
 * JUDGING_ROUND_ENTRY: the person's project (their team's, or their own when
 * solo) was advanced into the round (a JudgingRoundEntry) and is not
 * withdrawn or disqualified. Optionally the round's finalists must be published.
 */
export const judgingRoundEntry: EligibilityResolver = {
  stage: "judgingRoundId",
  async evaluate(client, claimant, terms) {
    const roundId = terms.judgingRoundId;
    if (!roundId || claimant.isCrew) return no("Only participants with a project qualify.");
    const round = await client.judgingRound.findFirst({ where: { id: roundId, eventId: claimant.eventId }, select: { finalistsPublishedAt: true } });
    if (!round) return no("The judging round no longer exists.");
    const submission = await client.submission.findFirst({
      where: { eventId: claimant.eventId, ...(claimant.teamId ? { teamId: claimant.teamId } : { rsvpId: claimant.rsvpId }) },
      select: { id: true, status: true, roundEntries: { where: { roundId }, select: { id: true } } },
    });
    if (!submission) return no("No project was entered.");
    const facts = { submissionId: submission.id, submissionStatus: submission.status, inRound: submission.roundEntries.length > 0, finalistsPublished: Boolean(round.finalistsPublishedAt) };
    if (submission.status === SubmissionStatus.DISQUALIFIED) return no("The project was disqualified.", facts);
    if (submission.status === SubmissionStatus.WITHDRAWN) return no("The project was withdrawn.", facts);
    if (!facts.inRound) return no("The project is not in this round.", facts);
    if (terms.requireFinalistsPublished && !round.finalistsPublishedAt) return no("This round's finalists aren't published yet.", facts);
    return yes(facts);
  },
  async candidates(client, eventId, terms) {
    const roundId = terms.judgingRoundId;
    if (!roundId) return NOBODY;
    if (terms.requireFinalistsPublished) {
      const round = await client.judgingRound.findFirst({ where: { id: roundId, eventId }, select: { finalistsPublishedAt: true } });
      if (!round?.finalistsPublishedAt) return NOBODY;
    }
    const inRound = { status: { notIn: OUT }, roundEntries: { some: { roundId } } };
    return { isCrew: false, OR: [{ teamId: null, submission: inRound }, { team: { submission: inRound } }] };
  },
};
