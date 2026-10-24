import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { CHECK_IN_STATION_COOKIE, hasValidCheckInStationProof } from "@/lib/checkInStation";
import { badgeBrandingFor, badgeDesignFor, loadBadgeEvent } from "@/lib/badge/data";
type Props = { params: Promise<{ orgSlug: string; eventSlug: string; }>; };
function label(r: { user: { name: string | null; email: string | null; } | null; guestName: string | null; guestEmail: string | null; }) { return r.user?.name?.trim() || r.guestName?.trim() || r.user?.email || r.guestEmail || "Guest"; }
export async function loadVenueCheckInStationView({ params }: Props) {

  const { orgSlug, eventSlug } = await params;
  const event = await prisma.event.findFirst({ where: { slug: eventSlug, organisation: { slug: orgSlug } }, include: { organisation: { select: { slug: true, name: true } } } });
  // A disabled/missing station deliberately looks identical to an unknown URL.
  if (!event?.checkInStationPinHash) notFound();
  const proof = (await cookies()).get(CHECK_IN_STATION_COOKIE)?.value;
  if (!hasValidCheckInStationProof(proof, event.id, event.checkInStationSecretVersion, event.startDateTime, event.endDateTime)) return { unlocked: false as const, orgSlug, eventSlug };
  const [confirmed, checkedIn, recentRsvps, form, badgeEvent] = await Promise.all([
    prisma.rSVP.count({ where: { eventId: event.id, status: "CONFIRMED" } }),
    prisma.rSVP.count({ where: { eventId: event.id, checkedInAt: { not: null } } }),
    prisma.rSVP.findMany({ where: { eventId: event.id, checkedInAt: { not: null } }, orderBy: { checkedInAt: "desc" }, take: 200, include: { user: { select: { name: true, email: true } } } }),
    prisma.eventRegistrationForm.findUnique({ where: { eventId: event.id }, select: { fields: { select: { key: true, label: true }, orderBy: { sortOrder: "asc" } } } }),
    loadBadgeEvent(event.id),
  ]);
  if (!badgeEvent) notFound();
  // The station prints the event's saved badge design; it cannot change it.
  const badge = { design: badgeDesignFor(badgeEvent), branding: badgeBrandingFor(badgeEvent), canSave: false };

  return { unlocked: true as const, event: { id: event.id, slug: event.slug, title: event.title, organisation: event.organisation, teamEvent: event.registrationMode === "TEAM" }, confirmed, checkedIn, fields: form?.fields ?? [], recent: recentRsvps.map((r) => ({ rsvpId: r.id, displayName: label(r), email: r.user?.email ?? r.guestEmail, checkedInAt: r.checkedInAt!.toISOString() })), badge };
}
