import "server-only";

import { loadEntrantSubmission, type EntrantAuth } from "@/lib/core/judging";
import { formatDayTime, formatTimeZoneName } from "@/lib/format/datetime";
import { safeTimeZone } from "@/lib/timeZone";
import type { SubmissionEditorView } from "@/components/submission/SubmissionEditor";
import { windowPhase } from "@/components/submission/submissionWindow";
import { formatMoney } from "@/lib/payments/money";

/**
 * The entrant's own submission, loaded through the core (which re-checks the
 * entrant's proof) and shaped for the editor. Null when the event does not
 * take submissions or the proof no longer holds. Dates are formatted here in
 * the event's timezone; the client gets labels only. Called by view readers.
 */
export async function loadSubmissionEditorView(auth: EntrantAuth, now = new Date()): Promise<SubmissionEditorView | null> {
  const view = await loadEntrantSubmission(auth, now);
  if (!view) return null;
  const timeZone = safeTimeZone(view.timezone);
  const label = (value: Date | null) => (value ? `${formatDayTime(value, timeZone)} ${formatTimeZoneName(value, timeZone)}` : null);

  const editorView: SubmissionEditorView = {
    entrantName: view.entrantName,
    isTeam: view.isTeam,
    eventTitle: view.eventTitle,
    phase: windowPhase(view.window, now),
    opensLabel: label(view.window.opensAt),
    closesLabel: label(view.window.closesAt),
    confirmed: view.confirmed,
    declined: view.declined,
    canEdit: view.canEdit,
    entryFee: view.entryFee ? { label: formatMoney(view.entryFee.amountMinor, view.entryFee.currency), paid: view.entryFee.paid } : null,
    submission: view.submission
      ? {
          title: view.submission.title,
          summary: view.submission.summary,
          repoUrl: view.submission.repoUrl,
          demoUrl: view.submission.demoUrl,
          videoUrl: view.submission.videoUrl,
          status: view.submission.status,
          submittedLabel: label(view.submission.submittedAt),
        }
      : null,
  };
  return editorView;
}
