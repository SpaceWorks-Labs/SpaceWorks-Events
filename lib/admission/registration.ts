import { createHash } from "node:crypto";
import { AdmissionStatus, type Prisma } from "@prisma/client";

/*
 * Registration rules on events taking applications (docs/ADMISSION.md), as
 * friendly refusals before the database guards (admission_registration_guard)
 * would raise:
 * - one application per person per event: any key of the person (their
 *   attendee key, and their email as a guest key) already in an application
 *   of the event can't register again, whatever happened to it. Keys are
 *   stored only as one-way hashes (`admissionKeyHash`);
 * - a team takes new members only while its application is in review, and
 *   only an untouched solo application (never reviewed, decided or edited)
 *   moves into a team;
 * - organiser-added paid guests (paid by hand, waived or sent a link) would
 *   skip review and the offer, so they are refused.
 */

export const ALREADY_APPLIED = "You've already applied to this event. Each person applies once.";
export const TEAM_APPLICATION_DECIDED = "This team's application has already been decided, so it can't take new members.";
export const OWN_APPLICATION_CLOSED = "Your own application has already been reviewed or decided, so it can't move into a team. Withdraw it first if you'd rather apply with a team (you won't be able to apply again).";
export const MANUAL_PAID_REFUSAL = "This event takes applications: add the guest without payment so they're reviewed, or ask them to apply. Paid places are paid once an offer is accepted.";

/** The stored form of a person key: 'h:' + SHA-256 hex (the same as the database's admission_key_hash). */
export function admissionKeyHash(raw: string): string {
  return `h:${createHash("sha256").update(raw, "utf8").digest("hex")}`;
}

/** Every key a person registering is known by: the attendee key, and each email as a guest key. */
export function personKeys(attendeeKey: string, emails: Array<string | null | undefined> = []): string[] {
  const raw = [attendeeKey, ...emails.filter((email): email is string => Boolean(email?.trim())).map((email) => `guest:${email.trim().toLowerCase()}`)];
  return [...new Set(raw.map(admissionKeyHash))];
}

async function takesApplications(tx: Prisma.TransactionClient, eventId: string) {
  return Boolean((await tx.event.findUnique({ where: { id: eventId }, select: { admissionEnabled: true } }))?.admissionEnabled);
}

export async function admissionRegistrationRefusal(tx: Prisma.TransactionClient, eventId: string, attendeeKey: string, emails: Array<string | null | undefined> = []): Promise<string | null> {
  if (!(await takesApplications(tx, eventId))) return null;
  const existing = await tx.admissionApplication.count({ where: { eventId, applicantKeys: { hasSome: personKeys(attendeeKey, emails) } } });
  return existing ? ALREADY_APPLIED : null;
}

/** Whether an application is still untouched: in review, never changed, reviewed, decided or edited. */
async function untouched(tx: Prisma.TransactionClient, applicationId: string): Promise<boolean> {
  const app = await tx.admissionApplication.findUnique({
    where: { id: applicationId },
    select: { status: true, version: true, decisionRevision: true, _count: { select: { reviews: true, decisions: true, answerRevisions: true } } },
  });
  return Boolean(app && app.status === AdmissionStatus.IN_REVIEW && app.version === 1 && app.decisionRevision === 0 && app._count.reviews + app._count.decisions + app._count.answerRevisions === 0);
}

export async function admissionJoinRefusal(tx: Prisma.TransactionClient, params: { teamId: string; rsvpId?: string | null }): Promise<string | null> {
  const team = await tx.admissionApplication.findUnique({ where: { teamId: params.teamId }, select: { status: true } });
  if (team && team.status !== AdmissionStatus.IN_REVIEW) return TEAM_APPLICATION_DECIDED;
  if (params.rsvpId) {
    const own = await tx.admissionApplication.findUnique({ where: { rsvpId: params.rsvpId }, select: { id: true } });
    if (own && !(await untouched(tx, own.id))) return OWN_APPLICATION_CLOSED;
  }
  return null;
}
