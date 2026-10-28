import "server-only";

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { minorToDecimalString } from "@/lib/payments/money";

/*
 * The participation part of the personal data export (/api/exports/account,
 * docs/SECURITY.md "Data privacy"): the account's own crew places, expense
 * claims it filed, volunteer shifts, hours and certificates, mentor
 * profiles, help requests and comments it wrote, office-hour bookings it
 * made, team seeker profiles and join requests, and prize payouts to its
 * projects. Every query is keyed on the user; every field is allow-listed in
 * `buildParticipationExport` (never a spread), so tokens, hashes, storage
 * keys, payment references and other people's details never reach the file.
 */

export const PARTICIPATION_EXPORT_LIMIT = 500;

const eventTitle = { select: { title: true } } as const;

const crewSelect = {
  name: true, email: true, role: true, kind: true, foodPreference: true, bio: true, linkedinUrl: true, showOnPage: true, joinedViaLink: true, createdAt: true,
  // Read only to say whether a photo is on file; the storage key is never exported.
  photoUrl: true,
  event: eventTitle,
} as const satisfies Prisma.EventCrewMemberSelect;

const claimSelect = {
  eventTitle: true, kind: true, status: true, category: true, description: true, amountMinor: true, approvedMinor: true, currency: true,
  payeeName: true, payeeEmail: true, decisionNote: true, decidedAt: true, createdAt: true,
  policy: { select: { name: true } },
  _count: { select: { receipts: true } },
} as const satisfies Prisma.ExpenseClaimSelect;

const signupSelect = {
  status: true, attendance: true, checkedInAt: true, checkedOutAt: true, breakMinutes: true, createdAt: true,
  shift: { select: { title: true, zone: true, task: true, startsAt: true, endsAt: true, event: eventTitle } },
  hours: { select: { minutes: true, state: true } },
} as const satisfies Prisma.VolunteerShiftSignupSelect;

const certificateSelect = { role: true, kind: true, minutes: true, issuedAt: true, revokedAt: true, crewMember: { select: { event: eventTitle } } } as const satisfies Prisma.ContributorCertificateSelect;
const mentorSelect = { skills: true, bio: true, affiliation: true, availability: true, maxActiveTeams: true, showOnPage: true, createdAt: true, event: eventTitle } as const satisfies Prisma.MentorProfileSelect;
const helpSelect = { summary: true, location: true, status: true, origin: true, rating: true, createdAt: true, resolvedAt: true, cancelledAt: true, category: { select: { label: true } }, event: eventTitle } as const satisfies Prisma.HelpRequestSelect;
const commentSelect = { body: true, createdAt: true, request: { select: { summary: true, event: eventTitle } } } as const satisfies Prisma.HelpRequestCommentSelect;
// The mentor running the slot is someone else: only the time and place are exported.
const bookingSelect = { status: true, cancelReason: true, createdAt: true, cancelledAt: true, team: { select: { name: true } }, slot: { select: { startsAt: true, endsAt: true, location: true, event: eventTitle } } } as const satisfies Prisma.OfficeHourBookingSelect;
const seekerSelect = { headline: true, skills: true, visible: true, createdAt: true, rsvp: { select: { event: eventTitle } } } as const satisfies Prisma.TeamSeekerProfileSelect;
const joinRequestSelect = { direction: true, status: true, createdAt: true, team: { select: { name: true, event: eventTitle } } } as const satisfies Prisma.TeamJoinRequestSelect;
// The organiser's payment reference and note are never read.
const payoutSelect = { awardName: true, projectTitle: true, amountMinor: true, currency: true, paidAt: true, reversesId: true, event: eventTitle } as const satisfies Prisma.PrizePayoutSelect;

export type ParticipationSource = {
  crew: Prisma.EventCrewMemberGetPayload<{ select: typeof crewSelect }>[];
  expenseClaims: Prisma.ExpenseClaimGetPayload<{ select: typeof claimSelect }>[];
  volunteerSignups: Prisma.VolunteerShiftSignupGetPayload<{ select: typeof signupSelect }>[];
  contributorCertificates: Prisma.ContributorCertificateGetPayload<{ select: typeof certificateSelect }>[];
  mentorProfiles: Prisma.MentorProfileGetPayload<{ select: typeof mentorSelect }>[];
  helpRequests: Prisma.HelpRequestGetPayload<{ select: typeof helpSelect }>[];
  helpComments: Prisma.HelpRequestCommentGetPayload<{ select: typeof commentSelect }>[];
  officeHourBookings: Prisma.OfficeHourBookingGetPayload<{ select: typeof bookingSelect }>[];
  teamSeekerProfiles: Prisma.TeamSeekerProfileGetPayload<{ select: typeof seekerSelect }>[];
  teamJoinRequests: Prisma.TeamJoinRequestGetPayload<{ select: typeof joinRequestSelect }>[];
  prizePayouts: Prisma.PrizePayoutGetPayload<{ select: typeof payoutSelect }>[];
};

export async function loadParticipationSource(userId: string): Promise<ParticipationSource> {
  const take = PARTICIPATION_EXPORT_LIMIT;
  const ownCrew = { OR: [{ userId }, { rsvp: { userId } }] } satisfies Prisma.EventCrewMemberWhereInput;
  const ownRsvp = { rsvp: { userId } } as const;
  const newest = { createdAt: "desc" } as const;
  const [crew, expenseClaims, volunteerSignups, contributorCertificates, mentorProfiles, helpRequests, helpComments, officeHourBookings, teamSeekerProfiles, teamJoinRequests, prizePayouts] = await Promise.all([
    prisma.eventCrewMember.findMany({ where: ownCrew, select: crewSelect, orderBy: newest, take }),
    prisma.expenseClaim.findMany({ where: { submittedByUserId: userId }, select: claimSelect, orderBy: newest, take }),
    prisma.volunteerShiftSignup.findMany({ where: { crewMember: ownCrew }, select: signupSelect, orderBy: newest, take }),
    prisma.contributorCertificate.findMany({ where: { crewMember: ownCrew }, select: certificateSelect, orderBy: { issuedAt: "desc" }, take }),
    prisma.mentorProfile.findMany({ where: { userId }, select: mentorSelect, orderBy: newest, take }),
    prisma.helpRequest.findMany({ where: { raisedByUserId: userId }, select: helpSelect, orderBy: newest, take }),
    prisma.helpRequestComment.findMany({ where: { authorUserId: userId }, select: commentSelect, orderBy: newest, take }),
    prisma.officeHourBooking.findMany({ where: { bookedByUserId: userId }, select: bookingSelect, orderBy: newest, take }),
    prisma.teamSeekerProfile.findMany({ where: ownRsvp, select: seekerSelect, orderBy: newest, take }),
    prisma.teamJoinRequest.findMany({ where: ownRsvp, select: joinRequestSelect, orderBy: newest, take }),
    // Payouts to a project the account entered: solo, or one of its teams.
    prisma.prizePayout.findMany({ where: { submission: { OR: [{ rsvp: { userId } }, { team: { members: { some: { userId } } } }] } }, select: payoutSelect, orderBy: { paidAt: "desc" }, take }),
  ]);
  return { crew, expenseClaims, volunteerSignups, contributorCertificates, mentorProfiles, helpRequests, helpComments, officeHourBookings, teamSeekerProfiles, teamJoinRequests, prizePayouts };
}

const iso = (value: Date | null | undefined) => (value ? value.toISOString() : null);
const money = (minor: bigint | null, currency: string) => (minor == null ? null : minorToDecimalString(minor, currency));

/** Shape the participation sections with explicit allow-listed fields only. */
export function buildParticipationExport(source: ParticipationSource) {
  return {
    crewPlaces: source.crew.map((row) => ({
      event: row.event.title, name: row.name, email: row.email, role: row.role, kind: row.kind, foodPreference: row.foodPreference, bio: row.bio,
      linkedinUrl: row.linkedinUrl, hasPhoto: Boolean(row.photoUrl), shownOnEventPage: row.showOnPage, joinedViaLink: row.joinedViaLink, addedAt: row.createdAt.toISOString(),
    })),
    expenseClaims: source.expenseClaims.map((claim) => ({
      event: claim.eventTitle, policy: claim.policy?.name ?? null, kind: claim.kind, status: claim.status, category: claim.category, description: claim.description,
      currency: claim.currency, amount: money(claim.amountMinor, claim.currency), approvedAmount: money(claim.approvedMinor, claim.currency),
      payeeName: claim.payeeName, payeeEmail: claim.payeeEmail, decisionNote: claim.decisionNote || null, receipts: claim._count.receipts,
      submittedAt: claim.createdAt.toISOString(), decidedAt: iso(claim.decidedAt),
    })),
    volunteerShifts: source.volunteerSignups.map((signup) => ({
      event: signup.shift.event.title, shift: signup.shift.title, zone: signup.shift.zone, task: signup.shift.task, startsAt: signup.shift.startsAt.toISOString(), endsAt: signup.shift.endsAt.toISOString(),
      status: signup.status, attendance: signup.attendance, checkedInAt: iso(signup.checkedInAt), checkedOutAt: iso(signup.checkedOutAt), breakMinutes: signup.breakMinutes,
      hours: signup.hours ? { minutes: signup.hours.minutes, state: signup.hours.state } : null, signedUpAt: signup.createdAt.toISOString(),
    })),
    contributorCertificates: source.contributorCertificates.map((certificate) => ({
      event: certificate.crewMember.event.title, role: certificate.role, kind: certificate.kind, minutes: certificate.minutes, issuedAt: certificate.issuedAt.toISOString(), revokedAt: iso(certificate.revokedAt),
    })),
    mentorProfiles: source.mentorProfiles.map((profile) => ({
      event: profile.event.title, skills: [...profile.skills], bio: profile.bio, affiliation: profile.affiliation, availability: profile.availability,
      maxActiveTeams: profile.maxActiveTeams, shownOnEventPage: profile.showOnPage, createdAt: profile.createdAt.toISOString(),
    })),
    helpRequests: source.helpRequests.map((request) => ({
      event: request.event.title, category: request.category.label, summary: request.summary, location: request.location, status: request.status, origin: request.origin,
      rating: request.rating, raisedAt: request.createdAt.toISOString(), resolvedAt: iso(request.resolvedAt), cancelledAt: iso(request.cancelledAt),
    })),
    helpComments: source.helpComments.map((comment) => ({ event: comment.request.event.title, request: comment.request.summary, comment: comment.body, writtenAt: comment.createdAt.toISOString() })),
    officeHourBookings: source.officeHourBookings.map((booking) => ({
      event: booking.slot.event.title, team: booking.team.name, startsAt: booking.slot.startsAt.toISOString(), endsAt: booking.slot.endsAt.toISOString(), location: booking.slot.location,
      status: booking.status, cancelReason: booking.cancelReason, bookedAt: booking.createdAt.toISOString(), cancelledAt: iso(booking.cancelledAt),
    })),
    teamSeekerProfiles: source.teamSeekerProfiles.map((profile) => ({ event: profile.rsvp.event?.title ?? null, headline: profile.headline, skills: [...profile.skills], visible: profile.visible, createdAt: profile.createdAt.toISOString() })),
    teamJoinRequests: source.teamJoinRequests.map((request) => ({ event: request.team.event.title, team: request.team.name, direction: request.direction, status: request.status, createdAt: request.createdAt.toISOString() })),
    prizePayouts: source.prizePayouts.map((payout) => ({
      event: payout.event?.title ?? null, award: payout.awardName, project: payout.projectTitle, currency: payout.currency, amount: money(payout.amountMinor, payout.currency),
      reversal: payout.reversesId != null, paidAt: payout.paidAt.toISOString(),
    })),
  };
}
