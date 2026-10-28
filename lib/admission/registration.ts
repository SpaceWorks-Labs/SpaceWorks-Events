import { AdmissionStatus, type Prisma } from "@prisma/client";

/*
 * Registration rules on events taking applications (docs/ADMISSION.md), as
 * friendly refusals before the database guards (admission_registration_guard)
 * would raise:
 * - one application per person per event: an attendee key already in an
 *   application of the event can't register again, whatever happened to it;
 * - a team takes new members only while its application is in review, and
 *   an applicant whose own application is closed or holds an offer can't join one;
 * - organiser-added paid guests (paid by hand, waived or sent a link) would
 *   skip review and the offer, so they are refused.
 */

export const ALREADY_APPLIED = "You've already applied to this event. Each person applies once.";
export const TEAM_APPLICATION_DECIDED = "This team's application has already been decided, so it can't take new members.";
export const OWN_APPLICATION_CLOSED = "Your own application is closed or holds an offer, so you can't join a team here.";
export const MANUAL_PAID_REFUSAL = "This event takes applications: add the guest without payment so they're reviewed, or ask them to apply. Paid places are paid once an offer is accepted.";

async function takesApplications(tx: Prisma.TransactionClient, eventId: string) {
  return Boolean((await tx.event.findUnique({ where: { id: eventId }, select: { admissionEnabled: true } }))?.admissionEnabled);
}

export async function admissionRegistrationRefusal(tx: Prisma.TransactionClient, eventId: string, attendeeKey: string): Promise<string | null> {
  if (!(await takesApplications(tx, eventId))) return null;
  const existing = await tx.admissionApplication.count({ where: { eventId, applicantKeys: { has: attendeeKey } } });
  return existing ? ALREADY_APPLIED : null;
}

export async function admissionJoinRefusal(tx: Prisma.TransactionClient, params: { teamId: string; rsvpId?: string | null }): Promise<string | null> {
  const team = await tx.admissionApplication.findUnique({ where: { teamId: params.teamId }, select: { status: true } });
  if (team && team.status !== AdmissionStatus.IN_REVIEW) return TEAM_APPLICATION_DECIDED;
  if (params.rsvpId) {
    const own = await tx.admissionApplication.findUnique({ where: { rsvpId: params.rsvpId }, select: { status: true } });
    if (own && own.status !== AdmissionStatus.IN_REVIEW && own.status !== AdmissionStatus.WAITLISTED) return OWN_APPLICATION_CLOSED;
  }
  return null;
}
