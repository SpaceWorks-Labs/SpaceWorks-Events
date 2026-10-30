import { eventForView } from "@/lib/frontend/eventView";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { EventStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { resolvePublicEventAccess } from "@/lib/publicEventAccess";
type Props = { params: Promise<{ orgSlug: string; eventSlug: string; }>; };
export async function loadRouteMetadata(): Promise<Metadata> { return { title: "Event feedback", robots: { index: false, follow: false } }; }
export async function loadFeedbackView({ params }: Props) {
  const { orgSlug, eventSlug } = await params;
  const event = await prisma.event.findFirst({ where: { organisation: { slug: orgSlug }, slug: eventSlug, status: EventStatus.PUBLISHED }, include: { page: { select: { accentColor: true, isPublished: true } }, feedbackForm: { include: { fields: { orderBy: { sortOrder: "asc" } } } } } });
  if (!event?.feedbackForm?.isOpen) notFound();
  // Only for people who may open the event page itself: invite-only and unreleased events stay hidden.
  const access = await resolvePublicEventAccess({ organisationId: event.organisationId, eventId: event.id, status: event.status, privacyType: event.privacyType, websiteReleased: event.page?.isPublished ?? false });
  if (!access.allowed) notFound();
  const fields = event.feedbackForm.fields.map((field) => ({ id: field.id, key: field.key, label: field.label, type: field.type, required: field.required, sortOrder: field.sortOrder, options: Array.isArray(field.options) ? field.options.filter((value): value is string => typeof value === "string") : [] }));
  return { event: { ...eventForView(event), feedbackForm: event.feedbackForm }, orgSlug, eventSlug, fields };
}
