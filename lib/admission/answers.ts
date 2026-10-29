import "server-only";

import { AdmissionAssignmentStatus, AdmissionStatus, Prisma, RegistrationFieldType } from "@prisma/client";
import { prisma } from "@/lib/db";
import { validateAndNormalizeAnswers } from "@/lib/rsvpCore/answers";
import type { AnswerRow as NewAnswer } from "@/lib/rsvpCore/shared";
import { admissionKeyHash } from "./registration";
import { AdmissionError, CHANGED, lockAdmissionEvent, unitMembers } from "./state";

/*
 * An application's people and answers (docs/ADMISSION.md). Reviewers on a
 * blind stage see no names, emails, phone numbers or team name: people are
 * numbered and email and phone questions are left out.
 *
 * Applicants may change their answers while the application is in review
 * and not yet locked (the first released decision locks it). Each change
 * keeps the replaced answers (AdmissionAnswerRevision, append-only) and bumps
 * the answers revision, so reviews of the old answers stop counting and
 * their reviewers are asked again. The organiser's registration editor and
 * the buyer's order page follow the same rules: every answer write goes
 * through `replaceRegistrationAnswers`.
 */

type AnswerRow = { fieldId: string; valueText: string | null; valueBool: boolean | null; valueNumber: number | null; valueDate: Date | null; field: { label: string; type: RegistrationFieldType; sortOrder: number } };

export type ShownAnswer = { fieldId: string; label: string; value: string };
export type ApplicantPerson = { rsvpId: string; name: string; email: string | null; isLeader: boolean; answers: ShownAnswer[] };

const answerSelect = { fieldId: true, valueText: true, valueBool: true, valueNumber: true, valueDate: true, field: { select: { label: true, type: true, sortOrder: true } } } as const;
const HIDDEN_WHEN_BLIND: readonly RegistrationFieldType[] = [RegistrationFieldType.EMAIL, RegistrationFieldType.PHONE];

export function answerText(row: Pick<AnswerRow, "valueText" | "valueBool" | "valueNumber" | "valueDate">): string {
  if (row.valueBool != null) return row.valueBool ? "Yes" : "No";
  if (row.valueNumber != null) return String(row.valueNumber);
  if (row.valueDate) return row.valueDate.toISOString().slice(0, 10);
  if (row.valueText == null) return "";
  try {
    const parsed: unknown = JSON.parse(row.valueText);
    if (Array.isArray(parsed)) return parsed.map(String).join(", ");
  } catch {
    // Plain text.
  }
  return row.valueText;
}

export async function applicationPeople(client: Prisma.TransactionClient, app: { rsvpId: string | null; teamId: string | null }, blind: boolean): Promise<{ teamName: string | null; people: ApplicantPerson[] }> {
  const members = await unitMembers(client, app);
  const team = app.teamId ? await client.team.findUnique({ where: { id: app.teamId }, select: { name: true, leaderRsvpId: true } }) : null;
  const answers = await client.rsvpAnswer.findMany({ where: { rsvpId: { in: members.map((member) => member.id) } }, select: { rsvpId: true, ...answerSelect } });
  const people = members.map((member, index): ApplicantPerson => ({
    rsvpId: member.id,
    name: blind ? `Applicant ${index + 1}` : member.user?.name?.trim() || member.guestName?.trim() || "Guest",
    email: blind ? null : member.user?.email ?? member.guestEmail ?? null,
    isLeader: Boolean(team && team.leaderRsvpId === member.id),
    answers: answers
      .filter((row) => row.rsvpId === member.id && !(blind && HIDDEN_WHEN_BLIND.includes(row.field.type)))
      .sort((a, b) => a.field.sortOrder - b.field.sortOrder)
      .map((row) => ({ fieldId: row.fieldId, label: row.field.label, value: answerText(row) })),
  }));
  return { teamName: blind ? null : team?.name ?? null, people };
}

const DECIDED = "Your answers can't change any more: a decision has been made.";

/** Order-insensitive comparison key for a registration's answers. */
function answersKey(rows: NewAnswer[]) {
  return JSON.stringify(rows
    .map((row) => JSON.stringify([row.fieldId, row.valueText ?? null, row.valueBool ?? null, row.valueNumber ?? null, row.valueDate?.toISOString() ?? null]))
    .sort());
}

/**
 * Replace one registration's answers, inside a transaction that holds its
 * Event lock. Unchanged answers are left alone (an edit of the name only
 * writes nothing here). For an application, changed answers are refused
 * (AdmissionError) unless it is in review and not locked; the replaced
 * answers are kept, the answers revision and version go up, and submitted
 * reviews are asked again, so a reviewer still holding the old answers is
 * refused as stale (lib/admission/reviews.ts).
 */
export async function replaceRegistrationAnswers(
  tx: Prisma.TransactionClient,
  rsvp: { id: string; eventId: string | null; teamId: string | null; attendeeKey: string },
  rows: NewAnswer[],
  decided = "This application's answers can't change any more: a decision has been made.",
): Promise<void> {
  const previous = await tx.rsvpAnswer.findMany({ where: { rsvpId: rsvp.id }, select: answerSelect });
  if (answersKey(previous) === answersKey(rows)) return;
  const app = rsvp.eventId
    ? await tx.admissionApplication.findFirst({ where: rsvp.teamId ? { teamId: rsvp.teamId } : { rsvpId: rsvp.id }, select: { id: true, status: true, answersLockedAt: true, answersRevision: true, version: true } })
    : null;
  if (app) {
    if (app.status !== AdmissionStatus.IN_REVIEW || app.answersLockedAt) throw new AdmissionError(decided);
    await tx.admissionAnswerRevision.create({
      data: { applicationId: app.id, rsvpId: rsvp.id, personKey: admissionKeyHash(rsvp.attendeeKey), answersRevision: app.answersRevision, answers: previous.map((row) => ({ fieldId: row.fieldId, label: row.field.label, value: answerText(row) })) as Prisma.InputJsonValue },
    });
  }
  await tx.rsvpAnswer.deleteMany({ where: { rsvpId: rsvp.id } });
  if (rows.length) {
    await tx.rsvpAnswer.createMany({
      data: rows.map((row) => ({ rsvpId: rsvp.id, fieldId: row.fieldId, valueText: row.valueText ?? null, valueBool: row.valueBool ?? null, valueNumber: row.valueNumber ?? null, valueDate: row.valueDate ?? null })),
    });
  }
  if (!app) return;
  const bumped = await tx.admissionApplication.updateMany({ where: { id: app.id, version: app.version }, data: { answersRevision: { increment: 1 }, version: { increment: 1 } } });
  if (bumped.count !== 1) throw new AdmissionError(CHANGED);
  // Reviews of the old answers no longer count: their reviewers are asked again.
  await tx.admissionReviewAssignment.updateMany({ where: { applicationId: app.id, status: AdmissionAssignmentStatus.SUBMITTED }, data: { status: AdmissionAssignmentStatus.ASSIGNED } });
}

/** The applicant's own edit of their answers, by ticket token. */
export async function editApplicationAnswers(token: string, input: Record<string, unknown>): Promise<{ ok: true } | { ok: false; error: string }> {
  const rsvp = await prisma.rSVP.findUnique({ where: { checkInToken: token }, select: { id: true, eventId: true, teamId: true, isCrew: true, attendeeKey: true } });
  if (!rsvp?.eventId || rsvp.isCrew) return { ok: false, error: "This ticket has no application." };
  const form = await prisma.eventRegistrationForm.findUnique({ where: { eventId: rsvp.eventId }, select: { fields: { select: { id: true, key: true, label: true, type: true, required: true, options: true, settings: true } } } });
  if (!form || form.fields.length === 0) return { ok: false, error: "This event asks no questions." };
  const validated = validateAndNormalizeAnswers({ fields: form.fields, answers: input });
  if ("error" in validated) return { ok: false, error: validated.error };
  try {
    return await prisma.$transaction(async (tx) => {
      await lockAdmissionEvent(tx, rsvp.eventId!);
      const app = await tx.admissionApplication.findFirst({ where: rsvp.teamId ? { teamId: rsvp.teamId } : { rsvpId: rsvp.id }, select: { status: true, answersLockedAt: true } });
      if (!app) return { ok: false as const, error: "This ticket has no application." };
      if (app.status !== AdmissionStatus.IN_REVIEW || app.answersLockedAt) return { ok: false as const, error: DECIDED };
      await replaceRegistrationAnswers(tx, rsvp, validated.rows, DECIDED);
      return { ok: true as const };
    });
  } catch (error) {
    if (error instanceof AdmissionError) return { ok: false, error: error.message };
    throw error;
  }
}
