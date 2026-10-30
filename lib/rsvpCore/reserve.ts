import { EventPrivacyType, EventStatus, Prisma, RegistrationMode, RsvpStatus, SoloPolicy } from "@prisma/client";
import { prisma } from "@/lib/db";
import { enqueueRsvpConfirmation, enqueueTeamCreated } from "@/lib/outbox";
import type { TeamRegistrationIntent } from "@/lib/validators";
import { noticeOrganisersOfRequest } from "@/lib/notices";
import { notifyChatAbout } from "@/lib/chat/notify";
import { isRegistrationClosed } from "@/lib/registrationCutoff";
import { seatTakingWhere } from "@/lib/payments/holds";
import { lockSeriesDates } from "@/lib/payments/targets";
import { publicRegistrationCount } from "@/lib/publicRegistrationCount";
import { emitWebhookEvent } from "@/lib/webhooks/emit";
import { CREW_EMAIL_REFUSED, hasCrewEmail } from "@/lib/core/crew/shared";
import { RsvpInviteRequiredError, RsvpTargetClosedError } from "./shared";
import { admissionRegistrationRefusal } from "@/lib/admission/registration";
import { placeTeamRegistration, TeamRegistrationError, type TeamEventSettings } from "./team";

export function decideRsvpStatus(params: {
  capacity: number | null;
  confirmedCount: number;
  privacyType: EventPrivacyType;
}): RsvpStatus {
  const { capacity, confirmedCount, privacyType } = params;
  const full = capacity != null && confirmedCount >= capacity;

  if (privacyType === EventPrivacyType.APPROVAL_REQUIRED) {
    return RsvpStatus.PENDING_APPROVAL;
  }
  if (full) {
    return RsvpStatus.WAITLISTED;
  }
  return RsvpStatus.CONFIRMED;
}

export type RsvpTarget = { eventId: string } | { eventInstanceId: string };

/**
 * Public registration on an invite-only event or series, under the target's
 * lock: only a signed-in account whose email is on the current invitation
 * list, for its own single place. Organiser adds (`enforceOpen: false`) skip it.
 */
async function requireInvitation(tx: Prisma.TransactionClient, owner: { eventId: string } | { eventSeriesId: string }, userId: string | null | undefined, email: string) {
  if (!userId) throw new RsvpInviteRequiredError(false);
  const invited = "eventId" in owner
    ? await tx.eventInvite.count({ where: { eventId: owner.eventId, email } })
    : await tx.seriesInvite.count({ where: { eventSeriesId: owner.eventSeriesId, email } });
  if (invited === 0) throw new RsvpInviteRequiredError(true);
}

/**
 * Locks the event/occurrence row before counting confirmed attendees. This
 * serializes admissions for a capacity while retaining a database constraint
 * as the final duplicate-registration guard.
 */
export async function reserveRsvp(params: {
  target: RsvpTarget;
  capacity: number | null;
  privacyType: EventPrivacyType;
  data: Omit<Prisma.RSVPUncheckedCreateInput, "status">;
  notification: { to: string; eventTitle: string };
  afterCreate?: (tx: Prisma.TransactionClient, rsvpId: string) => Promise<void>;
  enforceOpen?: boolean;
  /** How to register on a TEAM event; omitted means solo. INDIVIDUAL events refuse team intents. */
  team?: TeamRegistrationIntent;
  /** Organiser manual add: a solo registration is allowed even on a TEAMS_ONLY event. */
  allowSoloWithoutTeam?: boolean;
}) {
  const reservation = await prisma.$transaction(async (tx) => {
    let capacity = params.capacity;
    let privacyType = params.privacyType;
    let teamEvent: TeamEventSettings | null = null;
    if ("eventId" in params.target) {
      await tx.$queryRaw`SELECT "id" FROM "Event" WHERE "id" = ${params.target.eventId} FOR UPDATE`;
      const current = await tx.event.findUnique({
        where: { id: params.target.eventId },
        select: { capacity: true, privacyType: true, status: true, endDateTime: true, registrationClosesAt: true, registrationLeadMinutes: true, startDateTime: true, registrationMode: true, teamMaxSize: true, soloPolicy: true, page: { select: { isPublished: true } } },
      });
      if (!current) throw new RsvpTargetClosedError();
      if (params.enforceOpen !== false && (current.status !== EventStatus.PUBLISHED || current.page?.isPublished !== true || current.endDateTime <= new Date() || isRegistrationClosed(current))) throw new RsvpTargetClosedError();
      capacity = current.capacity;
      privacyType = current.privacyType;
      if (params.enforceOpen !== false && privacyType === EventPrivacyType.INVITE_ONLY) await requireInvitation(tx, params.target, params.data.userId, params.notification.to);
      if (current.registrationMode === RegistrationMode.TEAM) teamEvent = current;
      // A crew member already holds a free crew ticket (docs/CREW.md); a second registration would take a place.
      if (await hasCrewEmail(tx, params.target.eventId, [params.notification.to])) throw new TeamRegistrationError(CREW_EMAIL_REFUSED);
      // Applications (docs/ADMISSION.md): one per person per event.
      const applied = await admissionRegistrationRefusal(tx, params.target.eventId, params.data.attendeeKey, [params.notification.to]);
      if (applied) throw new TeamRegistrationError(applied);
    } else {
      // The series row, then the date: the same order every series path locks in.
      const date = await tx.eventInstance.findUnique({ where: { id: params.target.eventInstanceId }, select: { eventSeriesId: true } });
      if (!date) throw new RsvpTargetClosedError();
      await lockSeriesDates(tx, date.eventSeriesId, [params.target.eventInstanceId], new Date());
      const current = await tx.eventInstance.findUnique({ where: { id: params.target.eventInstanceId }, select: { endDateTime: true, capacity: true, cancelledAt: true, series: { select: { capacity: true, privacyType: true, status: true } } } });
      if (!current) throw new RsvpTargetClosedError();
      if (params.enforceOpen !== false && (current.series.status !== EventStatus.PUBLISHED || current.endDateTime <= new Date() || current.cancelledAt)) throw new RsvpTargetClosedError();
      capacity = current.capacity ?? current.series.capacity;
      privacyType = current.series.privacyType;
      if (params.enforceOpen !== false && privacyType === EventPrivacyType.INVITE_ONLY) await requireInvitation(tx, { eventSeriesId: date.eventSeriesId }, params.data.userId, params.notification.to);
    }

    const intent = params.team;
    let status: RsvpStatus;
    let team: { id: string; name: string; } | null = null;
    let newTeamManageToken: string | null = null;
    if (!teamEvent) {
      if (intent && intent.mode !== "solo") throw new TeamRegistrationError("This event does not use team registration.");
      // Paid tickets still being paid for hold their seats too.
      const confirmedCount = await tx.rSVP.count({
        where: {
          ...params.target,
          ...seatTakingWhere(new Date()),
        },
      });
      status = decideRsvpStatus({ capacity, confirmedCount, privacyType });
    } else {
      // TEAM event (docs/TEAMS.md): capacity counts units, under the Event lock above.
      ({ status, team, newTeamManageToken } = await placeTeamRegistration(tx, {
        eventId: (params.target as { eventId: string; }).eventId, capacity, privacyType, settings: teamEvent, intent, allowSoloWithoutTeam: params.allowSoloWithoutTeam,
      }));
    }
    const rsvp = await tx.rSVP.create({
      data: { ...params.data, status, teamId: team?.id ?? null },
      select: { id: true, checkInToken: true },
    });
    if (team && newTeamManageToken) {
      await tx.team.update({ where: { id: team.id }, data: { leaderRsvpId: rsvp.id } });
      await enqueueTeamCreated(tx, { to: params.notification.to, teamId: team.id, manageToken: newTeamManageToken, reason: "created" });
    }
    await enqueueRsvpConfirmation(tx, {
      to: params.notification.to,
      eventTitle: params.notification.eventTitle,
      status,
      checkInToken: rsvp.checkInToken,
      ...(team ? { teamName: team.name } : {}),
    });
    if (teamEvent && intent?.mode === "solo" && intent.seeker && teamEvent.soloPolicy === SoloPolicy.SOLO_WITH_MATCHING) {
      await tx.teamSeekerProfile.create({ data: { rsvpId: rsvp.id, headline: intent.seeker.headline, skills: intent.seeker.skills, visible: true } });
    }
    if (status === RsvpStatus.PENDING_APPROVAL) await noticeOrganisersOfRequest(tx, params.target);
    else {
      const who = (typeof params.data.guestName === "string" && params.data.guestName.trim()) || "Someone";
      await notifyChatAbout(tx, params.target, "registration", (title) => `${who} registered for ${title}${status === RsvpStatus.WAITLISTED ? " (waitlist)" : ""}.`);
    }
    await params.afterCreate?.(tx, rsvp.id);
    // Only what the event page shows (null when hidden), never a capacity input.
    const count = await publicRegistrationCount(tx, params.target);
    return { ...rsvp, status, count, teamId: team?.id ?? null };
  });
  emitWebhookEvent({ type: "registration.created", rsvpId: reservation.id });
  return reservation;
}
