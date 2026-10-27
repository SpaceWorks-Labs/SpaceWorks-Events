import { toEventClientDto } from "@/lib/eventDto";
import type { EventDashboardContext } from "@/lib/eventDashboard/context";
import { loadRegistrationFields } from "@/lib/eventDashboard/data";
import { loadRegistrationLock } from "@/lib/eventDashboard/teams";
import { formatDayShort, formatTime } from "@/lib/format/datetime";
import { type EventPagePreviewData } from "@/components/event/EventWebsiteManager";
import { htmlExcerpt, programmeCounts } from "@/components/event-dashboard/event-page/summary";
export async function loadEventPagePanel({ ctx }: { ctx: EventDashboardContext; }) {
  ctx = await loadEventDashboard(ctx.organisation.slug, ctx.event.id);

  const { event, permissions, organisation, now } = ctx;
  // Registrations lock the registration mode in Details; the server refuses the change too.
  const [fields, registrations] = await Promise.all([
    loadRegistrationFields(event.id),
    permissions.canEditEventDetails ? loadRegistrationLock(event.id) : Promise.resolve(undefined),
  ]);
  const website = {
    page: event.page,
    highlights: event.highlights.map((x) => ({ id: x.id, title: x.title, description: x.description, visibility: x.visibility, values: { icon: x.icon, sortOrder: x.sortOrder } })),
    speakers: event.speakers.map((x) => ({ id: x.id, title: x.name, description: x.bioHtml, visibility: x.visibility, values: { headline: x.headline, organisation: x.organisation, photoUrl: x.photoUrl, websiteUrl: x.websiteUrl, linkedinUrl: x.linkedinUrl, xUrl: x.xUrl, sortOrder: x.sortOrder } })),
    sponsors: event.sponsors.map((x) => ({ id: x.id, title: x.name, description: x.description, visibility: x.visibility, values: { logoUrl: x.logoUrl, websiteUrl: x.websiteUrl, tier: x.tier, sortOrder: x.sortOrder } })),
    resources: event.resources.map((x) => ({ id: x.id, title: x.title, description: x.description, visibility: x.visibility, values: { externalUrl: x.externalUrl, sortOrder: x.sortOrder } })),
    faqs: event.faqs.map((x) => ({ id: x.id, title: x.question, description: x.answerHtml, visibility: x.visibility, values: { sortOrder: x.sortOrder } })),
  };
  const dto = toEventClientDto(event);
  const scheduleHref = permissions.canManageSchedule ? `/dashboard/${organisation.slug}/event/${event.id}/schedule` : null;
  const counts = programmeCounts(event.sessions, event.speakers.length);
  const publishedSessions = event.sessions
    .filter((session) => session.visibility === "PUBLISHED")
    .sort((a, b) => a.startDateTime.getTime() - b.startDateTime.getTime() || a.sortOrder - b.sortOrder);
  const sessionLines = publishedSessions.slice(0, 3).map((session) => ({ lead: formatTime(session.startDateTime, event.timezone), text: session.title }));
  if (publishedSessions.length > 3) sessionLines.push({ lead: "", text: `+${publishedSessions.length - 3} more` });
  const preview: EventPagePreviewData = {
    title: event.title,
    dateLine: `${formatDayShort(event.startDateTime, event.timezone, now)} · ${formatTime(event.startDateTime, event.timezone)}`,
    privacyType: event.privacyType,
    location: event.isOnline ? "" : event.location,
    isOnline: event.isOnline,
    aboutExcerpt: htmlExcerpt(event.page?.aboutHtml ?? ""),
    sessionCount: counts.sessionCount,
    sessionLines,
    scheduleHref,
  };

  return { event, permissions, organisation, now, fields, registrations, website, dto, scheduleHref, counts, publishedSessions, sessionLines, preview };
}
import { loadEventDashboard } from "@/lib/eventDashboard/context";
