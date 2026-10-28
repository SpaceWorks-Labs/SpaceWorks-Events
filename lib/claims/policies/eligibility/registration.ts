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

/** CREW: every confirmed crew member (docs/CREW.md), or only those of the policy's crew kinds. */
export const crewMember: EligibilityResolver = {
  stage: null,
  async evaluate(client, claimant, terms) {
    if (!claimant.isCrew) return no("This policy is for crew.");
    if (terms.crewKinds.length === 0) return yes({ crew: true });
    const member = await client.eventCrewMember.findUnique({ where: { rsvpId: claimant.rsvpId }, select: { kind: true } });
    const facts = { crew: true, crewKind: member?.kind ?? null };
    return member && terms.crewKinds.includes(member.kind) ? yes(facts) : no("This policy is for other crew roles.", facts);
  },
  async candidates(_client, _eventId, terms) {
    return terms.crewKinds.length ? { isCrew: true, crewMember: { kind: { in: terms.crewKinds } } } : { isCrew: true };
  },
};
