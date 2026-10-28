import { NOBODY, no, yes, type EligibilityResolver } from "./types";

/**
 * MENTORING_ROUND: the person's team took part in the Mentor Desk round (a
 * submitted, non-away check-in), by Mentor Desk's own rule
 * (lib/core/mentorDesk/rounds.ts). Mentoring is per team, so solo
 * participants never qualify. Mentor Desk's module is loaded on use: it pulls
 * in the desk's command layer, which the email worker shouldn't load.
 */
const rounds = () => import("@/lib/core/mentorDesk/rounds");

export const mentoringRound: EligibilityResolver = {
  stage: "mentoringRoundId",
  async evaluate(client, claimant, terms) {
    const roundId = terms.mentoringRoundId;
    if (!roundId || claimant.isCrew) return no("Only participants in a team qualify.");
    if (!claimant.teamId) return no("Only teams are mentored, and you are not in one.");
    const tookPart = await (await rounds()).tookPartInRound(client, { eventId: claimant.eventId, roundId, teamId: claimant.teamId });
    const facts = { teamId: claimant.teamId, tookPart };
    return tookPart ? yes(facts) : no("Your team hasn't taken part in this mentoring round.", facts);
  },
  async candidates(client, eventId, terms) {
    if (!terms.mentoringRoundId) return NOBODY;
    const teams = await (await rounds()).teamsThatTookPartInRound(client, eventId, terms.mentoringRoundId);
    return teams.size ? { isCrew: false, teamId: { in: [...teams] } } : NOBODY;
  },
};
