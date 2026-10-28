import type { Event } from "@prisma/client";

// Explicit Event fields and relations used by page renderers. Station secrets
// stay on the backend even when an organiser can operate that station. Every
// field here is event configuration, safe for public and dashboard renderers
// alike. The return type is a Pick, so TypeScript flags a renderer that reads
// a field this list drops.
const eventFieldList = [
  "id", "organisationId", "title", "slug", "description", "tags", "showRegistrationCount", "coverImageUrl",
  "startDateTime", "endDateTime", "timezone", "location", "mapLinkUrl", "isOnline", "capacity", "status", "privacyType",
  "listedPublicly", "registrationClosesAt", "registrationLeadMinutes", "shortCode", "createdAt",
  // Paid tickets: currency, the refund policy and transfers (lib/eventDto.ts).
  "currency", "refundPolicyKind", "refundPolicyHours", "refundPolicyPercent", "refundPolicyText",
  "allowTransfers", "transferCutoffHours",
  // Team registration (docs/TEAMS.md).
  "registrationMode", "teamMinSize", "teamMaxSize", "soloPolicy", "teamTicketMode",
  // Hackathon state the dashboard tabs and settings read (docs/HACKATHON.md).
  "submissionsEnabled", "judgingStatus", "resultsPublishedAt", "submissionFeeMinor", "submissionFeeRefundOnDisqualify",
  // Mentor Desk switches the dashboard tab and settings read (docs/MENTOR_DESK.md).
  "mentorDeskEnabled", "mentorHelpClaimedEmail", "mentorsGetCrewTicket",
  "page", "highlights", "speakers", "sponsors", "resources", "faqs", "sessions", "scheduleTracks", "organisation", "feedbackForm", "registrationForm", "badgeDesign", "_count",
] as const;
const eventFields = new Set<string>(eventFieldList);
type ViewField = (typeof eventFieldList)[number];
export type EventView<T> = Pick<T, Extract<keyof T, ViewField>>;

export function eventForView<T extends Partial<Event>>(event: T): EventView<T> {
  return Object.fromEntries(Object.entries(event).filter(([key]) => eventFields.has(key))) as EventView<T>;
}
