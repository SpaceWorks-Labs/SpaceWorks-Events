import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireAuth } from "@/lib/permissions";
import { resolveParticipantForUser } from "@/lib/core/mentorDesk/access";
import { loadParticipantDesk } from "@/lib/core/mentorDesk/readsParticipant";

/**
 * A signed-in participant's Mentor Desk page: the owner of a CONFIRMED
 * registration on an event with the desk on. The event id alone grants
 * nothing; anything else is a plain 404.
 */
export async function loadAccountMentoringView({ params }: { params: Promise<{ eventId: string; }>; }) {
  const session = await requireAuth();
  const { eventId } = await params;
  if (!eventId || eventId.length > 128) notFound();
  const event = await prisma.event.findUnique({ where: { id: eventId }, select: { id: true, title: true, organisation: { select: { slug: true } } } });
  if (!event) notFound();
  const participant = await resolveParticipantForUser(session.user.id, event.organisation.slug, event.id);
  if (!participant) notFound();
  const view = await loadParticipantDesk(participant);
  if (!view) notFound();
  return { view, title: event.title, deskRef: { organisationSlug: event.organisation.slug, eventId: event.id } };
}
