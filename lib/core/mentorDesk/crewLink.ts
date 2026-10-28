import "server-only";

/*
 * The Mentor Desk's crew hook (docs/MENTOR_DESK.md, docs/CREW.md). When the
 * event's `mentorsGetCrewTicket` is on, a new MENTOR grant adds the mentor to
 * the crew (kind MENTOR, role "Mentor", hidden from the public crew list,
 * linked to the mentor's account) with a free crew ticket, through the crew
 * core. Removing the grant removes that crew place,
 * and only a place this hook created (`MentorProfile.crewMemberId`). A mentor
 * who already has a registration or crew place on the event is left as is:
 * their own registration is never converted. Runs after the grant change
 * commits, because the crew core takes the Event lock in its own transaction.
 * Crew tickets are free: a mentor never pays and no order is created.
 */

import { CrewKind, EventPermission } from "@prisma/client";
import { prisma } from "@/lib/db";
import { addCrewMemberTx, afterCrewAdded, removeCrewMember } from "@/lib/core/crew/members";
import { eventForCrewSelect, findRegistrationByEmail, linkCrewAccount } from "@/lib/core/crew/shared";

export type MentorGrantChange = { eventId: string; userId: string; before: readonly EventPermission[]; after: readonly EventPermission[]; actorUserId: string };

export async function syncMentorCrewAfterGrant(change: MentorGrantChange): Promise<void> {
  const had = change.before.includes(EventPermission.MENTOR);
  const has = change.after.includes(EventPermission.MENTOR);
  if (has === had) return;
  const profile = await prisma.mentorProfile.findUnique({ where: { eventId_userId: { eventId: change.eventId, userId: change.userId } }, select: { id: true, crewMemberId: true } });
  if (!profile) return;
  if (!has) {
    if (!profile.crewMemberId) return;
    const event = await prisma.event.findUnique({ where: { id: change.eventId }, select: { organisationId: true } });
    if (event) await removeCrewMember({ organisationId: event.organisationId, eventId: change.eventId, actorUserId: change.actorUserId }, profile.crewMemberId);
    return;
  }
  if (profile.crewMemberId) return;
  const [event, user] = await Promise.all([
    prisma.event.findUnique({ where: { id: change.eventId }, select: { ...eventForCrewSelect, mentorsGetCrewTicket: true } }),
    prisma.user.findUnique({ where: { id: change.userId }, select: { name: true, email: true } }),
  ]);
  const email = user?.email?.trim().toLowerCase();
  if (!event?.mentorsGetCrewTicket || !email) return;
  if (await findRegistrationByEmail(prisma, event.id, email)) {
    // An existing crew place with this email is linked to the mentor's account (its kind stays the organiser's choice).
    await linkCrewAccount(prisma, change.userId, email, event.id);
    return;
  }
  const result = await addCrewMemberTx(event, { name: user?.name?.trim() || email, email, foodPreference: "", role: "Mentor", bio: "" }, { showOnPage: false, joinedViaLink: false, kind: CrewKind.MENTOR });
  if (!result.ok) return;
  // The grant proves the account, verified email or not (docs/VOLUNTEERS.md).
  await linkCrewAccount(prisma, change.userId, email, event.id);
  await prisma.mentorProfile.updateMany({ where: { id: profile.id, crewMemberId: null }, data: { crewMemberId: result.data.id } });
  await afterCrewAdded(event.id, result);
}
