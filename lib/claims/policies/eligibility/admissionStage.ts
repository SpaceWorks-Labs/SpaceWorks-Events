import { AdmissionStatus, type Prisma } from "@prisma/client";
import { NOBODY, no, yes, type EligibilityResolver } from "./types";

/**
 * ADMISSION_STAGE: the person's application reached the admission stage
 * (docs/ADMISSION.md), by Admission's own rule (`applicationReachedStage`:
 * a team member through the team's application, a solo registrant through
 * their own), and has been accepted. Applicants still in review, waitlisted
 * or offered never qualify, nor do withdrawn, declined, expired or rejected
 * ones. The admission module is loaded on use, keeping the email worker's
 * imports light.
 */
const stages = () => import("@/lib/admission/stages");

export const admissionStage: EligibilityResolver = {
  stage: "admissionStageId",
  async evaluate(client, claimant, terms) {
    const stageId = terms.admissionStageId;
    if (!stageId || claimant.isCrew) return no("Only applicants qualify.");
    const reached = await (await stages()).applicationReachedStage(client, { eventId: claimant.eventId, stageId, rsvpId: claimant.rsvpId });
    if (!reached) return no("Your application hasn't reached this stage.", { reachedStage: false });
    const application = await client.admissionApplication.findFirst({
      where: { eventId: claimant.eventId, ...(claimant.teamId ? { teamId: claimant.teamId } : { rsvpId: claimant.rsvpId }) },
      select: { status: true },
    });
    const facts = { reachedStage: true, applicationStatus: application?.status ?? null };
    return application?.status === AdmissionStatus.ACCEPTED ? yes(facts) : no("Your application hasn't been accepted.", facts);
  },
  async candidates(_client, eventId, terms) {
    const stageId = terms.admissionStageId;
    if (!stageId) return NOBODY;
    const application: Prisma.AdmissionApplicationWhereInput = { eventId, status: AdmissionStatus.ACCEPTED, entries: { some: { stageId, stage: { eventId } } } };
    return { isCrew: false, OR: [{ teamId: null, admissionApplication: application }, { team: { admissionApplication: application } }] };
  },
};
