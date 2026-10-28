import "server-only";

import { prisma } from "@/lib/db";

/*
 * The older approve, decline, promote and re-accept paths (guest list,
 * Teams view, waitlist offers) are refused for applications
 * (docs/ADMISSION.md): an application is decided only through a released
 * decision, so review coverage and the offer capacity can't be bypassed. The
 * database refuses a confirmed or held place without an offer as well
 * (admission_status_guard).
 */

export const ADMISSION_MANAGED = "This registration is an application. Decide it from the Applications tab, where its reviews and the offers are checked.";

/** Whether a registration (or its team) is an application. */
export async function isApplicationRsvp(rsvpId: string): Promise<boolean> {
  const rsvp = await prisma.rSVP.findUnique({ where: { id: rsvpId }, select: { teamId: true, admissionApplication: { select: { id: true } } } });
  if (!rsvp) return false;
  if (rsvp.admissionApplication) return true;
  return rsvp.teamId ? isApplicationTeam(rsvp.teamId) : false;
}

export async function isApplicationTeam(teamId: string): Promise<boolean> {
  return (await prisma.admissionApplication.count({ where: { teamId } })) > 0;
}
