import { no, yes, type EligibilityResolver } from "./types";

/** CONFIRMED_PARTICIPANT: every confirmed participant who is not crew. */
export const confirmedParticipant: EligibilityResolver = {
  stage: null,
  async evaluate(_client, claimant) {
    return claimant.isCrew ? no("Crew claim under crew policies.") : yes();
  },
  async candidates() {
    return { isCrew: false };
  },
};

/** CREW: every confirmed crew member (docs/CREW.md). */
export const crewMember: EligibilityResolver = {
  stage: null,
  async evaluate(_client, claimant) {
    return claimant.isCrew ? yes({ crew: true }) : no("This policy is for crew.");
  },
  async candidates() {
    return { isCrew: true };
  },
};
