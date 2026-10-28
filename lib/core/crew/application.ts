import "server-only";

import { AdmissionStatus, type Prisma } from "@prisma/client";
import { CLOSED_STATUSES } from "@/lib/admission/rules";
import { updateApplication } from "@/lib/admission/state";

/*
 * Turning an applicant's registration into a crew ticket (docs/CREW.md
 * "Applicants", docs/ADMISSION.md). A crew ticket is never an application,
 * so the application is detached from the registration first and kept, with
 * its reviews and decisions, as history:
 *
 * - closed (rejected, declined, expired, withdrawn): detached as it is, so a
 *   rejected applicant can still volunteer;
 * - open (in review, waitlisted, offered, accepted): only once the organiser
 *   confirms, and then WITHDRAWN, so an offer is never silently accepted by a
 *   crew ticket. The caller re-offers the freed place after commit.
 *
 * Callers hold the Event row lock.
 */

const OPEN_WARNING: Partial<Record<AdmissionStatus, string>> = {
  IN_REVIEW: "This person's application is still in review.",
  WAITLISTED: "This person is on the applications waitlist.",
  OFFERED: "This person has been offered a place and hasn't answered yet.",
  ACCEPTED: "This person has accepted a place through their application.",
};

/** The refusal for an open application the organiser hasn't confirmed withdrawing. */
export function withdrawWarning(status: AdmissionStatus): string {
  return `${OPEN_WARNING[status] ?? "This person has an open application."} Adding them to the crew withdraws their application for good, and any place it held goes to the waitlist. Confirm to continue.`;
}

export type CrewApplicationOutcome = { ok: true; withdrew: boolean } | { ok: false; error: string };

export async function detachApplicationForCrew(tx: Prisma.TransactionClient, rsvpId: string, confirmed: boolean): Promise<CrewApplicationOutcome> {
  const app = await tx.admissionApplication.findUnique({ where: { rsvpId }, select: { id: true, status: true, version: true } });
  if (!app) return { ok: true, withdrew: false };
  const open = !CLOSED_STATUSES.includes(app.status);
  if (open && !confirmed) return { ok: false, error: withdrawWarning(app.status) };
  await updateApplication(tx, app, { rsvpId: null, ...(open ? { status: AdmissionStatus.WITHDRAWN, queuedAt: null } : {}) });
  return { ok: true, withdrew: open };
}
