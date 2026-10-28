import type { Event } from "@prisma/client";

/** Event data that is safe to serialize into browser component props. */
export type EventClientDto = Omit<Event,
  "checkInStationPinHash" | "checkInStationPinEncrypted" | "checkInStationSecretVersion"
  // Judging settings have their own DTOs (lib/core/judging.ts).
  | "submissionsEnabled" | "submissionsOpenAt" | "submissionsCloseAt" | "judgingStatus" | "judgesSeeAll"
  | "projectGalleryPublic" | "resultsPublishedAt" | "resultsAnnouncedAt" | "reviewsPerProject" | "scoreNormalization" | "currentJudgingRoundId"
  | "emailEntrantsOnResults" | "emailSubmissionReceipts"
  // The entry fee is a BigInt and lives with the judging settings too.
  | "submissionFeeMinor" | "submissionFeeRefundOnDisqualify"
  // Finance settings have their own view (lib/finance.ts).
  | "budgetMinor" | "participantClaimsEnabled" | "participantClaimCapMinor" | "crewClaimsEnabled"
  // The ticket design is read by the ticket designer (lib/ticketDesign/).
  | "ticketDesignId"
  // Mentor Desk settings have their own view (lib/core/mentorDesk/).
  | "mentorDeskEnabled" | "mentorHelpClaimedEmail" | "mentorsGetCrewTicket"
>;

/** Copies only the DTO fields, so a full Event record never reaches the browser. */
export function toEventClientDto(event: EventClientDto): EventClientDto {
  return {
    id: event.id,
    organisationId: event.organisationId,
    title: event.title,
    slug: event.slug,
    description: event.description,
    tags: event.tags,
    showRegistrationCount: event.showRegistrationCount,
    coverImageUrl: event.coverImageUrl,
    startDateTime: event.startDateTime,
    endDateTime: event.endDateTime,
    timezone: event.timezone,
    location: event.location,
    mapLinkUrl: event.mapLinkUrl,
    isOnline: event.isOnline,
    capacity: event.capacity,
    status: event.status,
    privacyType: event.privacyType,
    listedPublicly: event.listedPublicly,
    registrationClosesAt: event.registrationClosesAt,
    registrationLeadMinutes: event.registrationLeadMinutes,
    currency: event.currency,
    refundPolicyKind: event.refundPolicyKind,
    refundPolicyHours: event.refundPolicyHours,
    refundPolicyPercent: event.refundPolicyPercent,
    refundPolicyText: event.refundPolicyText,
    allowTransfers: event.allowTransfers,
    transferCutoffHours: event.transferCutoffHours,
    shortCode: event.shortCode,
    registrationMode: event.registrationMode,
    teamMinSize: event.teamMinSize,
    teamMaxSize: event.teamMaxSize,
    soloPolicy: event.soloPolicy,
    teamTicketMode: event.teamTicketMode,
    createdAt: event.createdAt,
  };
}
