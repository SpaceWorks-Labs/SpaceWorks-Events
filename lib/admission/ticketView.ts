import "server-only";

import { AdmissionStatus, RsvpStatus, type RegistrationFieldType } from "@prisma/client";
import { prisma } from "@/lib/db";
import { formatDayTime } from "@/lib/format/datetime";
import { STATUS_LABELS } from "./rules";
import { isPaid, unitOrder } from "./state";

/*
 * "Your application" on the ticket page (docs/ADMISSION.md), for the person
 * holding the ticket link: the status and stage, the offer and its deadline,
 * and what they may do now. Never reviews, scores or other applicants.
 */

export type TicketApplicationView = {
  status: AdmissionStatus;
  statusLabel: string;
  stageName: string | null;
  respondBy: string | null;
  teamName: string | null;
  /** Solo applicant or team leader: answers the offer and withdraws. */
  canAnswer: boolean;
  paid: boolean;
  paying: boolean;
  canWithdraw: boolean;
  /** The current answers, editable until the first decision. */
  edit: { fields: Array<{ key: string; label: string; type: RegistrationFieldType; required: boolean; options: string[]; value: string; values: string[] }> } | null;
};

export async function loadTicketApplication(rsvp: { id: string; eventId: string | null; teamId: string | null; isCrew: boolean }, now = new Date()): Promise<TicketApplicationView | null> {
  if (!rsvp.eventId || rsvp.isCrew) return null;
  const app = await prisma.admissionApplication.findFirst({
    where: rsvp.teamId ? { teamId: rsvp.teamId } : { rsvpId: rsvp.id },
    select: { id: true, rsvpId: true, teamId: true, status: true, respondBy: true, answersLockedAt: true, currentStage: { select: { name: true } }, team: { select: { name: true, leaderRsvpId: true } }, event: { select: { timezone: true } } },
  });
  if (!app) return null;
  const canAnswer = !app.teamId || app.team?.leaderRsvpId === rsvp.id;
  const members = await prisma.rSVP.findMany({ where: app.rsvpId ? { id: app.rsvpId } : { teamId: app.teamId! }, select: { status: true, holdExpiresAt: true } });
  const paying = members.some((member) => member.status === RsvpStatus.PENDING_PAYMENT && member.holdExpiresAt && member.holdExpiresAt > now);
  const editable = app.status === AdmissionStatus.IN_REVIEW && !app.answersLockedAt;
  return {
    status: app.status,
    statusLabel: STATUS_LABELS[app.status],
    stageName: app.status === AdmissionStatus.IN_REVIEW ? app.currentStage?.name ?? null : null,
    respondBy: app.status === AdmissionStatus.OFFERED && app.respondBy ? formatDayTime(app.respondBy, app.event.timezone) : null,
    teamName: app.team?.name ?? null,
    canAnswer,
    paid: isPaid(await unitOrder(prisma, app)),
    paying,
    canWithdraw: canAnswer && !paying && ([AdmissionStatus.IN_REVIEW, AdmissionStatus.WAITLISTED, AdmissionStatus.OFFERED] as AdmissionStatus[]).includes(app.status),
    edit: editable ? await editableAnswers(rsvp.id, rsvp.eventId) : null,
  };
}

async function editableAnswers(rsvpId: string, eventId: string) {
  const form = await prisma.eventRegistrationForm.findUnique({ where: { eventId }, select: { fields: { orderBy: { sortOrder: "asc" }, select: { id: true, key: true, label: true, type: true, required: true, options: true } } } });
  if (!form || form.fields.length === 0) return null;
  const answers = await prisma.rsvpAnswer.findMany({ where: { rsvpId }, select: { fieldId: true, valueText: true, valueBool: true, valueNumber: true, valueDate: true } });
  return {
    fields: form.fields.map((field) => {
      const mine = answers.filter((row) => row.fieldId === field.id);
      const answer = mine[0];
      const value = answer?.valueBool != null ? String(answer.valueBool) : answer?.valueNumber != null ? String(answer.valueNumber) : answer?.valueDate ? answer.valueDate.toISOString().slice(0, 10) : answer?.valueText ?? "";
      // A multi-select keeps one answer row per choice.
      const values = mine.map((row) => row.valueText ?? "").filter(Boolean);
      return { key: field.key, label: field.label, type: field.type, required: field.required, options: Array.isArray(field.options) ? field.options.filter((option): option is string => typeof option === "string") : [], value, values };
    }),
  };
}
