import { notFound } from "next/navigation";
import { EventStatus, RegistrationMode } from "@prisma/client";
import { prisma } from "@/lib/db";
import { resolvePublicEventAccess } from "@/lib/publicEventAccess";
import { loadJoinPageTeam } from "@/lib/core/teams";
import { isTeamTokenShape } from "@/lib/teamToken";
import { publicTeamRegistrationConfig } from "@/lib/publicTeamConfig";
import { isRegistrationClosed } from "@/lib/registrationCutoff";
import { toFieldDefinition } from "@/lib/registrationFields";

/**
 * Team join link (docs/TEAMS.md). Access is resolved exactly as on the event
 * page (publication, website release, privacy and invite-only, organiser
 * preview), so the link never reveals an event its holder could not otherwise
 * see. Unknown, retired and other events' tokens share the same 404. Only the
 * team's name, size and maximum size are returned, never its members.
 */
export async function loadTeamJoinView({ params }: { params: Promise<{ orgSlug: string; eventSlug: string; joinToken: string; }>; }) {
  const { orgSlug, eventSlug, joinToken } = await params;
  if (!isTeamTokenShape(joinToken)) notFound();
  const org = await prisma.organisation.findUnique({ where: { slug: orgSlug } });
  if (!org) notFound();
  const event = await prisma.event.findUnique({ where: { organisationId_slug: { organisationId: org.id, slug: eventSlug } } });
  if (!event) notFound();
  const release = await prisma.eventPage.findUnique({ where: { eventId: event.id }, select: { isPublished: true, accentColor: true } });
  const access = await resolvePublicEventAccess({
    organisationId: org.id,
    eventId: event.id,
    status: event.status,
    privacyType: event.privacyType,
    websiteReleased: release?.isPublished ?? false,
  });
  if (!access.allowed) notFound();
  if (event.registrationMode !== RegistrationMode.TEAM) notFound();
  const team = await loadJoinPageTeam(event.id, joinToken);
  if (!team) notFound();
  const teamConfig = publicTeamRegistrationConfig(event);
  if (!teamConfig) notFound();
  const form = await prisma.eventRegistrationForm.findUnique({ where: { eventId: event.id }, include: { fields: { orderBy: { sortOrder: "asc" } } } });
  const registrationOpen = event.status === EventStatus.PUBLISHED && event.endDateTime > new Date() && !isRegistrationClosed(event);
  return {
    org: { slug: org.slug, name: org.name },
    event: { slug: event.slug, title: event.title, status: event.status, startDateTime: event.startDateTime, endDateTime: event.endDateTime, timezone: event.timezone, isOnline: event.isOnline, location: event.location },
    accentColor: release?.accentColor ?? null,
    preview: access.preview,
    team: { joinToken, name: team.name, size: team.size, maxSize: team.maxSize },
    teamConfig,
    fields: (form?.fields ?? []).map(toFieldDefinition),
    registrationOpen,
  };
}
