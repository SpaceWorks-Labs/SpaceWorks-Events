"use client";

import { useState } from "react";
import { ExternalLink } from "lucide-react";
import {
  assignProjectJudge,
  disqualifyProject,
  unassignProjectJudge,
  type SubmissionReviewView,
} from "@/app/actions/judging-admin";
import { Button } from "@/components/ui/button";
import { CheckboxField } from "@/components/ui/choice";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Callout, Chip } from "@/components/ui/display";
import { Field, Input } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { formatDayTime } from "@/lib/format/datetime";
import type { JudgingDashboardCriterion, JudgingDashboardJudge, JudgingDashboardSubmission } from "@/lib/eventDashboard/judging";
import { disqualifyImpact } from "../judgingCopy";
import { fieldError, useJudgingAction, type JudgingScope } from "../JudgingPanelShared";

/** A project link: validated https on write, opened without a referrer. */
export function ProjectLink({ href, children }: { href: string; children: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow ugc" className="inline-flex items-center gap-1 text-body-ui font-semibold text-ink underline underline-offset-2 hover:text-ink-secondary">
      {children}
      <ExternalLink aria-hidden className="size-3.5" />
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

export function ProjectDialog({ submission, onClose }: { submission: JudgingDashboardSubmission | null; onClose: () => void }) {
  return (
    <Dialog open={submission !== null} onOpenChange={(next) => (!next ? onClose() : undefined)}>
      <DialogContent size="md">
        <DialogHeader title={submission?.title ?? ""} description={submission ? `${submission.isTeam ? "Team" : "Solo"} · ${submission.entrantName}` : undefined} />
        <DialogBody className="flex flex-col gap-4">
          {submission?.summary ? <p className="whitespace-pre-line text-body-ui text-ink-secondary">{submission.summary}</p> : <p className="text-body-ui text-ink-muted">No summary.</p>}
          {submission && (submission.repoUrl || submission.demoUrl || submission.videoUrl) ? (
            <div className="flex flex-wrap gap-4">
              {submission.repoUrl ? <ProjectLink href={submission.repoUrl}>Code</ProjectLink> : null}
              {submission.demoUrl ? <ProjectLink href={submission.demoUrl}>Demo</ProjectLink> : null}
              {submission.videoUrl ? <ProjectLink href={submission.videoUrl}>Video</ProjectLink> : null}
            </div>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function AssignDialog({
  scope,
  submission,
  judges,
  onClose,
}: {
  scope: JudgingScope;
  submission: JudgingDashboardSubmission | null;
  judges: JudgingDashboardJudge[];
  onClose: () => void;
}) {
  const { run, busy } = useJudgingAction();
  const assigned = new Set(submission?.assignedJudgeIds ?? []);
  return (
    <Dialog open={submission !== null} onOpenChange={(next) => (!next ? onClose() : undefined)}>
      <DialogContent size="sm">
        <DialogHeader title="Assign judges" description={submission ? `Who judges "${submission.title}". Judges registered on this entry can't be assigned.` : undefined} />
        <DialogBody className="flex flex-col gap-3">
          {judges.length === 0 ? (
            <p className="text-body-ui text-ink-muted">No judges yet. Invite collaborators with the Judge permission in Settings.</p>
          ) : (
            judges.map((judge) => (
              <CheckboxField
                key={judge.userId}
                label={judge.name}
                description={judge.kind === "admin" ? "Organiser" : judge.email ?? "Judge"}
                checked={assigned.has(judge.userId)}
                disabled={busy !== null || !submission}
                onCheckedChange={(checked) => {
                  if (!submission) return;
                  const input = { ...scope, judgeUserId: judge.userId, submissionId: submission.id };
                  run(judge.userId, () => (checked === true ? assignProjectJudge(input) : unassignProjectJudge(input)), null);
                }}
              />
            ))
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function DisqualifyDialog({
  scope,
  submission,
  awardsHeld,
  resultsPublished,
  maxLength,
  onClose,
}: {
  scope: JudgingScope;
  submission: JudgingDashboardSubmission | null;
  awardsHeld: string[];
  resultsPublished: boolean;
  maxLength: number;
  onClose: () => void;
}) {
  const { run, busy } = useJudgingAction();
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<Record<string, string[]> | undefined>();
  const close = () => {
    setReason("");
    setErrors(undefined);
    onClose();
  };
  return (
    <Dialog open={submission !== null} onOpenChange={(next) => (!next && busy === null ? close() : undefined)}>
      <DialogContent role="alertdialog" size="sm">
        <DialogHeader
          title="Disqualify this project?"
          description={submission ? disqualifyImpact({ title: submission.title, awardsHeld, resultsPublished }) : undefined}
        />
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!submission) return;
            run("disqualify", () => disqualifyProject({ ...scope, submissionId: submission.id, reason }), "Project disqualified.", (result) => {
              if (result.ok) close();
              else setErrors(result.fieldErrors);
            });
          }}
        >
          <DialogBody className="flex flex-col gap-4">
            {resultsPublished && awardsHeld.length > 0 ? (
              <Callout tone="warning" title="The live results page will change">
                <ul className="list-disc pl-5">
                  {awardsHeld.map((award) => (
                    <li key={award}>{award}</li>
                  ))}
                </ul>
              </Callout>
            ) : null}
            <Field label="Reason" helperText="Only organisers see this. The entrant isn't told the reason." error={fieldError(errors, "reason")}>
              <Input value={reason} maxLength={maxLength} required onChange={(event) => setReason(event.target.value)} />
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button variant="secondary" disabled={busy !== null} onClick={close}>
              Cancel
            </Button>
            <Button type="submit" variant="danger" loading={busy === "disqualify"} loadingLabel="Disqualifying…">
              Disqualify
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ReviewsDialog({
  submission,
  reviews,
  criteria,
  timezone,
  onClose,
}: {
  submission: JudgingDashboardSubmission | null;
  reviews: SubmissionReviewView[] | null;
  criteria: JudgingDashboardCriterion[];
  timezone: string;
  onClose: () => void;
}) {
  const criterionNames = new Map(criteria.map((criterion) => [criterion.id, criterion]));

  return (
    <Dialog open={submission !== null} onOpenChange={(next) => (!next ? onClose() : undefined)}>
      <DialogContent size="md">
        <DialogHeader title="Judges' reviews" description={submission ? `"${submission.title}". Comments are private to organisers.` : undefined} />
        <DialogBody className="flex flex-col gap-4">
          {!reviews ? (
            <div className="flex justify-center py-6">
              <Spinner className="size-5" />
              <span className="sr-only">Loading reviews</span>
            </div>
          ) : reviews.length === 0 ? (
            <p className="text-body-ui text-ink-muted">No judge has reviewed this project yet.</p>
          ) : (
            reviews.map((review, index) => (
              <section key={index} className="flex flex-col gap-2 rounded-lg border border-line p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-label text-ink">{review.judgeName}</p>
                  <Chip size="sm" tone={review.submittedAt ? "success" : "warning"}>
                    {review.submittedAt ? `Submitted ${formatDayTime(review.submittedAt, timezone)}` : "In progress"}
                  </Chip>
                </div>
                {review.scores.length > 0 ? (
                  <ul className="flex flex-wrap gap-x-4 gap-y-1 text-caption text-ink-secondary">
                    {review.scores.map((score) => {
                      const criterion = criterionNames.get(score.criterionId);
                      return (
                        <li key={score.criterionId}>
                          {criterion?.name ?? "Criterion"}: <span className="font-semibold text-ink">{score.score}</span>
                          {criterion ? ` / ${criterion.maxScore}` : ""}
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
                {review.comment ? <p className="whitespace-pre-line text-body-ui text-ink-secondary">{review.comment}</p> : null}
              </section>
            ))
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
