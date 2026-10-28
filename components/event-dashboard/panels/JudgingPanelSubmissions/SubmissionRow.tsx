"use client";

import { Ban, Eye, MessageSquareText, MoreHorizontal, RotateCcw, UserCheck } from "lucide-react";
import { IconButton } from "@/components/ui/button";
import { Chip } from "@/components/ui/display";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { formatDayTime } from "@/lib/format/datetime";
import type { JudgingDashboardSubmission } from "@/lib/eventDashboard/judging";
import { SUBMISSION_STATUS_LABELS, SUBMISSION_STATUS_TONES } from "../JudgingPanelShared";

/** One project in the Submissions list, with its actions menu. */
export function SubmissionRow({
  submission,
  judgesSeeAll,
  timezone,
  judgeNames,
  busy,
  setViewing,
  openReviews,
  setAssigningId,
  setDisqualifying,
  setReinstating,
}: {
  submission: JudgingDashboardSubmission;
  judgesSeeAll: boolean;
  timezone: string;
  judgeNames: Map<string, string>;
  busy: string | null;
  setViewing: (submission: JudgingDashboardSubmission) => void;
  openReviews: (submission: JudgingDashboardSubmission) => void;
  setAssigningId: (id: string) => void;
  setDisqualifying: (submission: JudgingDashboardSubmission) => void;
  setReinstating: (submission: JudgingDashboardSubmission) => void;
}) {
  return (
    <li className="flex flex-col gap-2 px-4 py-3.5 sm:flex-row sm:items-start sm:gap-4">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-label text-ink">{submission.title}</p>
          <Chip size="sm" tone={SUBMISSION_STATUS_TONES[submission.status]}>
            {SUBMISSION_STATUS_LABELS[submission.status]}
          </Chip>
        </div>
        <p className="text-caption text-ink-muted">
          {submission.isTeam ? "Team" : "Solo"} · {submission.entrantName}
          {submission.submittedAt ? ` · submitted ${formatDayTime(submission.submittedAt, timezone)}` : ` · updated ${formatDayTime(submission.updatedAt, timezone)}`}
        </p>
        {submission.status === "DISQUALIFIED" && submission.disqualifiedReason ? (
          <p className="mt-1 text-caption text-danger-fg">Reason (only organisers see this): {submission.disqualifiedReason}</p>
        ) : null}
        {!judgesSeeAll && submission.status === "SUBMITTED" ? (
          <p className="mt-1 text-caption text-ink-muted">
            Judges:{" "}
            {submission.assignedJudgeIds.length === 0
              ? "none assigned"
              : submission.assignedJudgeIds.map((id) => judgeNames.get(id) ?? "Former judge").join(", ")}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Menu>
          <MenuTrigger asChild>
            <IconButton label={`Actions for ${submission.title}`} size="sm" disabled={busy === submission.id}>
              <MoreHorizontal />
            </IconButton>
          </MenuTrigger>
          <MenuContent align="end">
            <MenuItem icon={<Eye />} onSelect={() => setViewing(submission)}>
              View project
            </MenuItem>
            {submission.status === "SUBMITTED" || submission.status === "DISQUALIFIED" ? (
              <MenuItem icon={<MessageSquareText />} onSelect={() => openReviews(submission)}>
                Judges&apos; reviews
              </MenuItem>
            ) : null}
            {submission.status === "SUBMITTED" ? (
              <MenuItem icon={<UserCheck />} onSelect={() => setAssigningId(submission.id)}>
                Assign judges
              </MenuItem>
            ) : null}
            {submission.status === "SUBMITTED" ? (
              <>
                <MenuSeparator />
                <MenuItem danger icon={<Ban />} onSelect={() => setDisqualifying(submission)}>
                  Disqualify…
                </MenuItem>
              </>
            ) : null}
            {submission.status === "DISQUALIFIED" ? (
              <MenuItem icon={<RotateCcw />} onSelect={() => setReinstating(submission)}>
                Reinstate…
              </MenuItem>
            ) : null}
          </MenuContent>
        </Menu>
      </div>
    </li>
  );
}
