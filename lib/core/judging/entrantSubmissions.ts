import "server-only";

/** The entrant side: save, submit and withdraw a project, view it, and request a solo submission link. */

import { EventStatus, Prisma, RsvpStatus, SubmissionStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { enqueueSubmissionLink, enqueueSubmissionReceived } from "@/lib/outbox";
import { generateSubmissionLinkToken } from "@/lib/submissionToken";
import { entrantSubmissionView, type EntrantSubmissionDto } from "@/lib/judgingDto";
import { submissionContentSchema } from "@/lib/validators";
import {
  CHANGED,
  type EntrantAuth,
  entrantRefusal,
  EVENT_NOT_FOUND,
  fail,
  invalid,
  isForeignKeyViolation,
  isId,
  isSubmissionWindowOpen,
  isUniqueViolation,
  judgingEventSelect,
  type JudgingResult,
  lockEventShared,
  NOT_CONFIRMED,
  NOT_FOUND,
  ok,
  personEmail,
  personSelect,
  WINDOW_CLOSED,
} from "./shared";
import { entrantWhere, lockedEntrant, lockEntrantRow } from "./entrantAuth";
import { entryFeeOwed, entryFeePaid } from "@/lib/payments/entryFees";
import { DEFAULT_CURRENCY } from "@/lib/payments/money";
import { openEntryFeeCheckout } from "@/lib/payments/entryFeeCheckout";

// ---------------------------------------------------------------------------
// Entrant actions
// ---------------------------------------------------------------------------

const submissionStateSelect = { id: true, status: true, submittedAt: true } satisfies Prisma.SubmissionSelect;

async function writeSubmission(
  auth: EntrantAuth,
  input: unknown,
  mode: "draft" | "submit",
): Promise<JudgingResult<{ submissionId: string; status: SubmissionStatus; feeBuyer?: { email: string; name: string } }>> {
  const parsed = submissionContentSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  try {
    return await prisma.$transaction(async (tx): Promise<JudgingResult<{ submissionId: string; status: SubmissionStatus; feeBuyer?: { email: string; name: string } }>> => {
      const event = await lockEventShared(tx, auth.eventId);
      if (!event) return fail(EVENT_NOT_FOUND);
      await lockEntrantRow(tx, auth);
      const entrant = await lockedEntrant(tx, auth);
      if (!entrant) return fail(NOT_FOUND);
      const refusal = entrantRefusal(entrant.status);
      if (refusal) return fail(refusal);
      if (!isSubmissionWindowOpen(event, new Date())) return fail(WINDOW_CLOSED);
      const existing = await tx.submission.findFirst({ where: entrantWhere(entrant), select: submissionStateSelect });
      if (existing?.status === SubmissionStatus.DISQUALIFIED) return fail("This submission can no longer be changed. Contact the organisers.");

      const now = new Date();
      const wasSubmitted = existing?.status === SubmissionStatus.SUBMITTED;
      // An entry fee is paid first; the project is submitted when it lands.
      const feeOwed = mode === "submit" && !wasSubmitted && (await entryFeeOwed(tx, event.id, existing?.id ?? null)) != null;
      if (feeOwed && !entrant.submitter.email) return fail("Add an email address to your registration before paying the entry fee.");
      const status = (mode === "submit" && !feeOwed) || wasSubmitted ? SubmissionStatus.SUBMITTED : SubmissionStatus.DRAFT;
      const submittedAt = mode === "submit" && !wasSubmitted && !feeOwed ? now : wasSubmitted ? existing.submittedAt ?? now : null;
      const content = {
        title: parsed.data.title,
        summary: parsed.data.summary,
        repoUrl: parsed.data.repoUrl,
        demoUrl: parsed.data.demoUrl,
        videoUrl: parsed.data.videoUrl,
        status,
        submittedAt,
      };
      const saved = existing
        ? await tx.submission.update({ where: { id: existing.id }, data: content, select: { id: true, status: true } })
        : await tx.submission.create({
            data: { ...content, eventId: entrant.eventId, teamId: entrant.teamId, rsvpId: entrant.rsvpId },
            select: { id: true, status: true },
          });
      if (feeOwed) return ok({ submissionId: saved.id, status: saved.status, feeBuyer: { email: entrant.submitter.email!, name: entrant.submitter.name ?? entrant.displayName } });
      if (mode === "submit" && !wasSubmitted && entrant.submitter.email) {
        await enqueueSubmissionReceived(tx, {
          to: entrant.submitter.email,
          submissionId: saved.id,
          ...(entrant.submitter.name ? { recipientName: entrant.submitter.name.slice(0, 200) } : {}),
        });
      }
      return ok({ submissionId: saved.id, status: saved.status });
    });
  } catch (error) {
    // A concurrent first save for the same entrant, or the team/RSVP was
    // removed mid-flight. Never report internals.
    if (isUniqueViolation(error) || isForeignKeyViolation(error)) return fail(CHANGED);
    throw error;
  }
}

/** Save the project without submitting it. A SUBMITTED project stays submitted (an edit). */
export function saveSubmissionDraft(auth: EntrantAuth, input: unknown) {
  return writeSubmission(auth, input, "draft");
}

/**
 * Save and submit. Queues `submission-received` to the person acting when the
 * project becomes SUBMITTED. With an unpaid entry fee the project is saved as
 * a draft and `checkoutUrl` opens the fee's payment page; it is submitted
 * once paid.
 */
export async function submitSubmission(auth: EntrantAuth, input: unknown): Promise<JudgingResult<{ submissionId: string; status: SubmissionStatus; checkoutUrl?: string }>> {
  const written = await writeSubmission(auth, input, "submit");
  if (!written.ok || !written.data.feeBuyer) return written;
  const { submissionId, status, feeBuyer } = written.data;
  const userId = auth.kind === "team-member" || auth.kind === "solo-owner" ? auth.userId : null;
  const checkout = await openEntryFeeCheckout({ eventId: auth.eventId, submissionId, buyer: { userId, ...feeBuyer } });
  if ("error" in checkout) return fail(checkout.error);
  return ok("url" in checkout ? { submissionId, status, checkoutUrl: checkout.url } : { submissionId, status });
}

/** Withdraw a draft or submitted project while the window is open. Withdrawn projects can be re-submitted. */
export async function withdrawSubmission(auth: EntrantAuth): Promise<JudgingResult<{ status: SubmissionStatus }>> {
  return prisma.$transaction(async (tx): Promise<JudgingResult<{ status: SubmissionStatus }>> => {
    const event = await lockEventShared(tx, auth.eventId);
    if (!event) return fail(EVENT_NOT_FOUND);
    await lockEntrantRow(tx, auth);
    const entrant = await lockedEntrant(tx, auth);
    if (!entrant) return fail(NOT_FOUND);
    const refusal = entrantRefusal(entrant.status);
    if (refusal) return fail(refusal);
    if (!isSubmissionWindowOpen(event, new Date())) return fail(WINDOW_CLOSED);
    const existing = await tx.submission.findFirst({ where: entrantWhere(entrant), select: submissionStateSelect });
    if (!existing) return fail(NOT_FOUND);
    if (existing.status !== SubmissionStatus.DRAFT && existing.status !== SubmissionStatus.SUBMITTED) return fail("This submission cannot be withdrawn.");
    const updated = await tx.submission.updateMany({
      where: { id: existing.id, status: existing.status },
      data: { status: SubmissionStatus.WITHDRAWN, submittedAt: null },
    });
    if (updated.count !== 1) return fail(CHANGED);
    // Only SUBMITTED projects can hold an award.
    await tx.eventAwardWinner.deleteMany({ where: { submissionId: existing.id } });
    return ok({ status: SubmissionStatus.WITHDRAWN });
  });
}

/**
 * The entrant's own view. Never includes the disqualification reason. Like
 * the event page, it exists only while the event is published and its
 * website released: a draft, hidden, or cancelled event has no submission
 * page. Invite-only rules are not re-applied here, because the entrant's
 * proof (a registration on this event) already shows they were admitted.
 */
export async function loadEntrantSubmission(auth: EntrantAuth, now: Date = new Date()): Promise<EntrantSubmissionDto | null> {
  const event = await prisma.event.findUnique({
    where: { id: auth.eventId },
    select: { ...judgingEventSelect, page: { select: { isPublished: true } } },
  });
  if (!event?.submissionsEnabled || event.status !== EventStatus.PUBLISHED || event.page?.isPublished !== true) return null;
  const entrant = await lockedEntrant(prisma, auth);
  if (!entrant) return null;
  const submission = await prisma.submission.findFirst({
    where: entrantWhere(entrant),
    select: { id: true, title: true, summary: true, repoUrl: true, demoUrl: true, videoUrl: true, status: true, submittedAt: true },
  });
  const fee = await prisma.event.findUnique({ where: { id: event.id }, select: { submissionFeeMinor: true, currency: true } });
  const entryFee = fee?.submissionFeeMinor
    ? { amountMinor: fee.submissionFeeMinor, currency: fee.currency ?? DEFAULT_CURRENCY, paid: submission ? await entryFeePaid(prisma, submission.id) : false }
    : null;
  const isOpen = isSubmissionWindowOpen(event, now);
  const confirmed = entrant.status === RsvpStatus.CONFIRMED;
  return {
    entrantName: entrant.displayName,
    isTeam: entrant.teamId != null,
    eventTitle: event.title,
    timezone: event.timezone,
    window: { opensAt: event.submissionsOpenAt, closesAt: event.submissionsCloseAt, isOpen },
    confirmed,
    declined: entrant.status === RsvpStatus.REJECTED,
    canEdit: isOpen && confirmed && submission?.status !== SubmissionStatus.DISQUALIFIED,
    submission: entrantSubmissionView(submission),
    entryFee,
  };
}

/** Minimum time between two emailed links for one registration. */
const SUBMISSION_LINK_COOLDOWN_MS = 60_000;

/**
 * A solo registrant asks for their `/submit/{token}` link from the ticket
 * page. The link goes only to the registration's own address through the
 * outbox, so holding the ticket QR alone is never enough. Regenerating
 * replaces the stored digest, retiring the previous link. The raw token is
 * never returned.
 */
export async function requestSubmissionLink(holder: { rsvpId: string; eventId: string }): Promise<JudgingResult<{ sent: boolean }>> {
  if (!isId(holder.rsvpId) || !isId(holder.eventId)) return fail(NOT_FOUND);
  try {
    return await prisma.$transaction(async (tx): Promise<JudgingResult<{ sent: boolean }>> => {
      const event = await lockEventShared(tx, holder.eventId);
      if (!event?.submissionsEnabled || event.status !== EventStatus.PUBLISHED) return fail("This event is not taking project submissions.");
      const rsvp = await tx.rSVP.findFirst({
        where: { id: holder.rsvpId, eventId: event.id, isCrew: false },
        select: { id: true, teamId: true, status: true, ...personSelect, submissionLink: { select: { createdAt: true } } },
      });
      if (!rsvp) return fail(NOT_FOUND);
      if (rsvp.teamId) return fail("Your team's project is submitted from the team page, or by any member signed in to their account.");
      if (rsvp.status !== RsvpStatus.CONFIRMED) return fail(NOT_CONFIRMED);
      const to = personEmail(rsvp);
      if (!to) return fail("This registration has no email address to send the link to.");
      if (rsvp.submissionLink && Date.now() - rsvp.submissionLink.createdAt.getTime() < SUBMISSION_LINK_COOLDOWN_MS) {
        return ok({ sent: false });
      }
      const token = generateSubmissionLinkToken();
      await tx.submissionLink.upsert({
        where: { rsvpId: rsvp.id },
        create: { rsvpId: rsvp.id, tokenHash: token.hash },
        update: { tokenHash: token.hash, createdAt: new Date() },
      });
      await enqueueSubmissionLink(tx, { to: to.toLowerCase(), rsvpId: rsvp.id, token: token.raw });
      return ok({ sent: true });
    });
  } catch (error) {
    if (isUniqueViolation(error)) return fail("A link was just sent. Check your inbox.");
    throw error;
  }
}
