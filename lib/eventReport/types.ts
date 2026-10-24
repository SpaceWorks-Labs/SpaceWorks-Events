import "server-only";

import type { EventPrivacyType, RegistrationFieldType, RsvpStatus, SponsorTier } from "@prisma/client";
import type { RevenueSummary } from "@/lib/payments/revenueMetrics";

export type ReportRsvp = { status: RsvpStatus; checkedInAt: Date | null };

export type ReportRsvpMetrics = {
  total: number;
  confirmed: number;
  waitlisted: number;
  pendingApproval: number;
  rejected: number;
  checkedIn: number;
  noShows: number;
};

/** One question from a registration or feedback form, reduced to counts. */
export type ReportQuestion = {
  label: string;
  type: RegistrationFieldType;
  /** People who answered it. */
  answered: number;
  /** Per-option counts for choice questions; null for free-text, number, date, email and phone. */
  choices: Array<{ label: string; count: number }> | null;
};

export type ReportSession = { title: string; type: string; track: string; start: Date; end: Date; delayMinutes: number; speakers: string[] };
export type ReportSpeaker = { name: string; detail: string };
export type ReportSponsor = { name: string; tier: SponsorTier };
export type ReportBroadcast = { subject: string; sentAt: Date; recipientCount: number };
export type ReportCheckInSources = { organiser: number; offline: number; station: number };

/**
 * Everything the PDF shows. Attendee data is reduced to counts and timestamps
 * before it gets here: no names, emails, tickets or written answers.
 */
/**
 * TEAM events (docs/TEAMS.md): team and solo counts only. Never team names,
 * members or "looking for a team" profiles.
 */
export type ReportTeamMetrics = {
  /** Teams with at least one registration. */
  teams: number;
  /** Teams that had a place (confirmed). */
  confirmedTeams: number;
  /** Registrations without a team. */
  soloRegistrants: number;
  /** Solo registrants who had a place; with `confirmedTeams`, the units filled. */
  confirmedSoloRegistrants: number;
  /** Average people per team, one decimal; 0 with no teams. */
  averageTeamSize: number;
};

export type EventReportMetrics = ReportRsvpMetrics & {
  /** Set for TEAM events only. */
  teams?: ReportTeamMetrics | null;
  targetType: "event" | "occurrence";
  targetId: string;
  organisationId: string;
  organisationName: string;
  title: string;
  startDateTime: Date;
  endDateTime: Date;
  timeZone: string;
  location: string;
  isOnline: boolean;
  capacity: number | null;
  invitationCount: number;
  feedbackResponseCount: number | null;
  accentColor?: string | null;
  privacyType?: EventPrivacyType;
  tags?: string[];
  tagline?: string;
  venueName?: string;
  registrationClosesAt?: Date | null;
  /** When each registration was made, for the sign-up timeline. */
  signupDates?: Date[];
  /** When each confirmed guest was checked in. */
  checkInTimes?: Date[];
  checkInSources?: ReportCheckInSources | null;
  registrationQuestions?: ReportQuestion[];
  feedbackTitle?: string;
  feedbackQuestions?: ReportQuestion[];
  certificatesEnabled?: boolean;
  sessions?: ReportSession[];
  speakers?: ReportSpeaker[];
  sponsors?: ReportSponsor[];
  resourceCount?: number;
  broadcasts?: ReportBroadcast[];
  coOrganiserCount?: number;
  /** People who joined the waitlist (and are still registered), and how many got a place. */
  waitlist?: { joined: number; promoted: number } | null;
  /** Short-link visits, or null when the event has no short link. */
  shortLinkVisits?: number | null;
  /** Takings: the tickets sold for this event (or, for a date, that date's own tickets). */
  money?: RevenueSummary | null;
};
