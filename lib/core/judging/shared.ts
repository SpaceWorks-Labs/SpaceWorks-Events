import "server-only";

/** Shared judging rules: result shapes, entrant proofs, refusal copy, event locks, the submission window and gallery visibility. */

import { EventStatus, Prisma, RsvpStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { flattenZodErrors } from "@/app/actions/utils";
import type { JudgingOrganiserContext } from "@/lib/judgingAccess";
import type { ActionErrorCode } from "@/lib/actionErrorCode";
import { judgingCriterionDto, type JudgingCriterionDto } from "@/lib/judgingDto";

export type JudgingResult<T = undefined> =
  | { ok: true; data: T }
  | { ok: false; error: string; fieldErrors?: Record<string, string[]>; code?: JudgingRefusalCode };

/** Machine-readable judge-side refusals, passed through by the mobile API; the web shows only `error`. */
export type JudgingRefusalCode = Extract<ActionErrorCode, "JUDGING_CLOSED" | "INCOMPLETE_SCORES" | "NOT_VISIBLE">;

export function refuse(error: string, code: JudgingRefusalCode): { ok: false; error: string; code: JudgingRefusalCode } {
  return { ok: false, error, code };
}

/** How an entrant proved who they are. Re-verified in every transaction. */
export type EntrantAuth =
  | { kind: "team-token"; eventId: string; teamId: string; manageTokenHash: string }
  | { kind: "team-member"; eventId: string; teamId: string; userId: string }
  | { kind: "solo-owner"; eventId: string; rsvpId: string; userId: string }
  | { kind: "solo-link"; eventId: string; rsvpId: string; tokenHash: string };

export const NOT_FOUND = "Submission not found.";
export const EVENT_NOT_FOUND = "Event not found.";
export const WINDOW_CLOSED = "Submissions are not open right now.";
export const NOT_CONFIRMED = "Only confirmed registrations can submit a project.";
/** A REJECTED team or registration: final, like the team-side refusals in lib/core/teams.ts. */
const DECLINED = "The organisers declined this registration, so its project can't be submitted or changed.";

export function entrantRefusal(status: RsvpStatus): string | null {
  if (status === RsvpStatus.CONFIRMED) return null;
  return status === RsvpStatus.REJECTED ? DECLINED : NOT_CONFIRMED;
}
export const RUBRIC_FROZEN = "The rubric can only be changed before judging starts.";
export const JUDGING_NOT_OPEN = "Judging is not open.";
export const CHANGED = "This was changed by someone else. Refresh and try again.";

export function ok<T>(data: T): { ok: true; data: T } {
  return { ok: true, data };
}

export function okEmpty(): { ok: true; data: undefined } {
  return { ok: true, data: undefined };
}

export function fail(error: string, fieldErrors?: Record<string, string[]>): { ok: false; error: string; fieldErrors?: Record<string, string[]> } {
  return fieldErrors ? { ok: false, error, fieldErrors } : { ok: false, error };
}

export function invalid(error: Parameters<typeof flattenZodErrors>[0]) {
  return fail("Check the highlighted fields.", flattenZodErrors(error));
}

export function isId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

export function isUniqueViolation(error: unknown) {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "P2002";
}

export function isForeignKeyViolation(error: unknown) {
  return typeof error === "object" && error !== null && ((error as { code?: string }).code === "P2003" || (error as { code?: string }).code === "P2025");
}

export function personEmail(person: { guestEmail: string | null; user: { email: string | null } | null } | null | undefined) {
  return person?.user?.email?.trim() || person?.guestEmail?.trim() || null;
}

export function personName(person: { guestName: string | null; user: { name: string | null } | null } | null | undefined) {
  return person?.user?.name?.trim() || person?.guestName?.trim() || undefined;
}

export const nameSourceSelect = {
  team: { select: { name: true } },
  rsvp: { select: { guestName: true, user: { select: { name: true } } } },
} satisfies Prisma.SubmissionSelect;

export const projectSelect = {
  id: true,
  title: true,
  summary: true,
  repoUrl: true,
  demoUrl: true,
  videoUrl: true,
  ...nameSourceSelect,
} satisfies Prisma.SubmissionSelect;

// ---------------------------------------------------------------------------
// Event locks and window
// ---------------------------------------------------------------------------

export const judgingEventSelect = {
  id: true,
  organisationId: true,
  title: true,
  slug: true,
  timezone: true,
  status: true,
  submissionsEnabled: true,
  submissionsOpenAt: true,
  submissionsCloseAt: true,
  judgingStatus: true,
  judgesSeeAll: true,
  reviewsPerProject: true,
  scoreNormalization: true,
  currentJudgingRoundId: true,
  projectGalleryPublic: true,
  resultsPublishedAt: true,
  resultsAnnouncedAt: true,
  // Hackathon email switches (lib/hackathonEmails.ts), read under the Event lock.
  emailEntrantsOnResults: true,
  emailSubmissionReceipts: true,
} satisfies Prisma.EventSelect;

export type JudgingEvent = Prisma.EventGetPayload<{ select: typeof judgingEventSelect }>;

export async function lockEventShared(tx: Prisma.TransactionClient, eventId: string): Promise<JudgingEvent | null> {
  await tx.$queryRaw`SELECT "id" FROM "Event" WHERE "id" = ${eventId} FOR SHARE`;
  return tx.event.findUnique({ where: { id: eventId }, select: judgingEventSelect });
}

/** Organiser lock, re-scoped by organisation. */
export async function lockEventForOrganiser(tx: Prisma.TransactionClient, ctx: { eventId: string; organisationId: string }): Promise<JudgingEvent | null> {
  await tx.$queryRaw`SELECT "id" FROM "Event" WHERE "id" = ${ctx.eventId} AND "organisationId" = ${ctx.organisationId} FOR UPDATE`;
  return tx.event.findFirst({ where: { id: ctx.eventId, organisationId: ctx.organisationId }, select: judgingEventSelect });
}

/** Whether the submission window is open at `now` (server time). */
export function isSubmissionWindowOpen(
  event: { submissionsEnabled: boolean; submissionsOpenAt: Date | null; submissionsCloseAt: Date | null; status?: EventStatus },
  now: Date = new Date(),
): boolean {
  if (!event.submissionsEnabled || !event.submissionsOpenAt || !event.submissionsCloseAt) return false;
  if (event.status !== undefined && event.status !== EventStatus.PUBLISHED) return false;
  return event.submissionsOpenAt <= now && now < event.submissionsCloseAt;
}

/** The public gallery is visible once the window has closed and the organiser turned it on. */
export function isProjectGalleryVisible(
  event: { submissionsEnabled: boolean; projectGalleryPublic: boolean; submissionsCloseAt: Date | null },
  now: Date = new Date(),
): boolean {
  return event.submissionsEnabled && event.projectGalleryPublic && event.submissionsCloseAt != null && event.submissionsCloseAt <= now;
}

export const personSelect = { guestEmail: true, guestName: true, user: { select: { email: true, name: true } } } as const;

export function sameIdSet(current: string[], next: string[]) {
  if (current.length !== next.length) return false;
  const wanted = new Set(next);
  return current.every((id) => wanted.has(id));
}

export async function withOrganiserLock<T>(ctx: JudgingOrganiserContext, run: (tx: Prisma.TransactionClient, event: JudgingEvent) => Promise<JudgingResult<T>>): Promise<JudgingResult<T>> {
  return prisma.$transaction(async (tx): Promise<JudgingResult<T>> => {
    const event = await lockEventForOrganiser(tx, ctx);
    if (!event) return fail(EVENT_NOT_FOUND);
    return run(tx, event);
  });
}

/** A round's rubric, in order (none for an event with no round yet). */
export async function criteriaFor(client: Prisma.TransactionClient, round: { id: string | null; eventId: string }): Promise<JudgingCriterionDto[]> {
  if (!round.id) return [];
  const rows = await client.judgingCriterion.findMany({
    where: { roundId: round.id, eventId: round.eventId },
    select: { id: true, name: true, description: true, weight: true, maxScore: true },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
  });
  return rows.map(judgingCriterionDto);
}

/** Projects per batch when a judging CSV streams (bounded reads of reviews and scores). */
export const JUDGING_EXPORT_BATCH_SIZE = 200;
