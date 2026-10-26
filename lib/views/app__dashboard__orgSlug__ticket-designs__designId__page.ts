import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireAuth } from "@/lib/permissions";
import { requireStaffMfa } from "@/lib/staffMfa";
import { editableDesign, resolveDesignActor } from "@/lib/ticketDesign/access";
import { CLASSIC_DESIGN } from "@/lib/ticketDesign/presets";
import { designDocumentSchema } from "@/lib/ticketDesign/schema";

type Props = { params: Promise<{ orgSlug: string; designId: string; }>; };

/**
 * The ticket designer page (docs/TICKET_DESIGNER.md): a library template for
 * owners and admins, or an event's design for its EDIT_DETAILS editors. For
 * an event, the newest registrations can stand in for the sample attendee in
 * the preview (names only).
 */
export async function loadTicketDesignerView({ params }: Props) {
  const { orgSlug, designId } = await params;
  const session = await requireAuth();
  await requireStaffMfa(session.user.id, `/dashboard/${orgSlug}/ticket-designs/${designId}`);
  const actor = await resolveDesignActor(session.user.id, orgSlug);
  const design = actor ? await editableDesign(actor, designId) : null;
  if (!actor || !design) notFound();
  const parsed = designDocumentSchema.safeParse(design.document);
  const event = design.eventId ? await prisma.event.findUnique({ where: { id: design.eventId }, select: { id: true, title: true } }) : null;
  const attendees = event
    ? await prisma.rSVP.findMany({ where: { eventId: event.id }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 50, select: { id: true, guestName: true, user: { select: { name: true } } } })
    : [];
  return {
    organisationSlug: actor.organisationSlug,
    design: { id: design.id, name: design.name, document: parsed.success ? parsed.data : CLASSIC_DESIGN },
    back: event ? { href: `/dashboard/${actor.organisationSlug}/event/${event.id}?tab=settings`, label: event.title } : { href: `/dashboard/${actor.organisationSlug}/ticket-designs`, label: "Ticket designs" },
    attendees: attendees.map((rsvp) => ({ id: rsvp.id, label: rsvp.user?.name?.trim() || rsvp.guestName?.trim() || "Guest" })),
  };
}
