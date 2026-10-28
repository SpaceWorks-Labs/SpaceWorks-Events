"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, ExternalLink, Users } from "lucide-react";
import { saveJudgeReviewAction } from "@/app/actions/judging";
import { useToast } from "@/components/feedback/ToastProvider";
import { Button } from "@/components/ui/button";
import { Callout, Card, Chip } from "@/components/ui/display";
import { Field, Textarea } from "@/components/ui/field";
import { cn } from "@/lib/cn";
import type { JudgeSubmissionDetailDto, JudgingCriterionDto } from "@/lib/judgingDto";
import {
  isFullyScored,
  judgingStatusNotice,
  linkLabel,
  noRubricNotice,
  scoreMapFrom,
  scoresToSave,
  type ScoreMap,
  type WorkspaceAudience,
} from "../judgeProgress";
import type { Scope } from "./types";
import { RecuseButton } from "./Recusal";

const COMMENT_MAX_LENGTH = 2000;

export function ScoringView({
  scope,
  detail,
  onBack,
  onSaved,
  onSubmitted,
  advancing,
  audience,
}: {
  scope: Scope;
  detail: JudgeSubmissionDetailDto;
  onBack: () => void;
  audience: WorkspaceAudience;
  onSaved: (next: JudgeSubmissionDetailDto) => void;
  /** A fresh review was submitted: the workspace opens the next project. */
  onSubmitted: () => void;
  /** The next project is loading. */
  advancing: boolean;
}) {
  const router = useRouter();
  const { showToast } = useToast();
  const [pending, startTransition] = useTransition();
  const [saving, setSaving] = useState<"draft" | "submit" | null>(null);
  const [scores, setScores] = useState<ScoreMap>(() => scoreMapFrom(detail.myScores, detail.criteria));
  const [comment, setComment] = useState(detail.myReview?.comment ?? "");
  const [error, setError] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  // The list button that opened this view is gone: move focus to the project's heading.
  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, []);
  const { submission, criteria, judgingStatus } = detail;
  const readOnly = judgingStatus !== "OPEN";
  const notice = judgingStatusNotice(judgingStatus, audience);
  const noRubric = noRubricNotice(audience);
  const submitted = Boolean(detail.myReview?.submittedAt);
  const complete = isFullyScored(scores, criteria);
  const links = [
    { label: "Code", url: submission.repoUrl },
    { label: "Demo", url: submission.demoUrl },
    { label: "Video", url: submission.videoUrl },
  ].filter((link): link is { label: string; url: string } => Boolean(link.url));

  function save(submit: boolean) {
    setError(null);
    setSaving(submit ? "submit" : "draft");
    startTransition(async () => {
      const entered = scoresToSave(scores, criteria);
      const res = await saveJudgeReviewAction({ ...scope, submissionId: submission.id, scores: entered, comment, submit });
      setSaving(null);
      if (!res.ok || !res.data) {
        const message = res.ok ? "Could not save your review." : res.error;
        setError(message);
        showToast(message, "error");
        return;
      }
      const nowSubmitted = res.data.submitted;
      onSaved({
        ...detail,
        submission: { ...submission, scoredCriteria: res.data.scored, reviewSubmitted: nowSubmitted },
        myScores: entered,
        myReview: { comment, submittedAt: nowSubmitted ? (detail.myReview?.submittedAt ?? new Date()) : null },
        canRecuse: detail.canRecuse && !nowSubmitted,
      });
      router.refresh();
      if (submit && nowSubmitted && !submitted) {
        onSubmitted();
        return;
      }
      showToast(submit ? (submitted ? "Review updated." : "Review submitted.") : "Scores saved.", "success");
    });
  }

  return (
    <section aria-labelledby="judge-submission-title" className="flex flex-col gap-5">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex min-h-9 items-center gap-1.5 self-start text-sm font-semibold text-ink-secondary hover:text-ink"
      >
        <ArrowLeft aria-hidden className="size-4" />
        All submissions
      </button>

      {notice ? <Callout tone={judgingStatus === "CLOSED" ? "info" : "warning"} title={notice.title}>{notice.body}</Callout> : null}

      <Card as="article" padding="lg" className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-2">
            {submission.isTeam ? <Chip size="sm" icon={<Users />}>Team</Chip> : null}
            {submitted ? <Chip size="sm" tone="success">Review submitted</Chip> : null}
          </div>
          <h2 id="judge-submission-title" ref={headingRef} tabIndex={-1} className="text-h3 break-words text-ink focus:outline-none">{submission.title}</h2>
          <p className="text-body-ui text-ink-muted">{submission.entrantName}</p>
        </div>
        {submission.summary ? <p className="whitespace-pre-wrap break-words text-body text-ink-secondary">{submission.summary}</p> : null}
        {links.length ? (
          <ul className="flex flex-wrap gap-2">
            {links.map((link) => (
              <li key={link.label}>
                <a
                  href={link.url}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                  referrerPolicy="no-referrer"
                  className="inline-flex min-h-9 items-center gap-1.5 rounded-full border border-line-strong bg-canvas px-3.5 text-sm font-semibold text-ink transition-colors hover:bg-subtle"
                >
                  {link.label}
                  <span className="max-w-[16ch] truncate font-normal text-ink-muted">{linkLabel(link.url)}</span>
                  <ExternalLink aria-hidden className="size-3.5 shrink-0" />
                  <span className="sr-only">(opens in a new tab)</span>
                </a>
              </li>
            ))}
          </ul>
        ) : null}
      </Card>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!readOnly && complete) save(true);
        }}
        className="flex flex-col gap-5"
      >
        <fieldset disabled={readOnly || pending} className="flex flex-col gap-4">
          <legend className="mb-1 text-title text-ink">Rubric</legend>
          {criteria.length === 0 ? (
            <p className="text-body-ui text-ink-muted">{noRubric.body}</p>
          ) : (
            criteria.map((criterion) => (
              <CriterionInput
                key={criterion.id}
                criterion={criterion}
                value={scores[criterion.id]}
                onChange={(score) => setScores((current) => ({ ...current, [criterion.id]: score }))}
              />
            ))
          )}
          <Field
            label="Private comment"
            optional
            helperText={`Only organisers see this. ${comment.length} / ${COMMENT_MAX_LENGTH}`}
          >
            <Textarea value={comment} onChange={(event) => setComment(event.target.value)} maxLength={COMMENT_MAX_LENGTH} rows={5} />
          </Field>
        </fieldset>

        {error ? <Callout tone="danger" role="alert">{error}</Callout> : null}

        {readOnly ? null : (
          <div className="flex flex-col-reverse gap-2.5 sm:flex-row sm:items-center sm:justify-end">
            {!complete && criteria.length > 0 ? (
              <p className="text-caption text-ink-muted sm:mr-auto">Score every criterion to submit your review.</p>
            ) : null}
            {detail.canRecuse ? <RecuseButton scope={scope} submissionId={submission.id} title={submission.title} onRecused={onBack} /> : null}
            <Button type="button" variant="secondary" onClick={() => save(false)} loading={saving === "draft"} disabled={pending}>
              Save scores
            </Button>
            <Button type="submit" variant="primary" loading={saving === "submit" || advancing} loadingLabel={advancing ? "Opening the next project…" : undefined} disabled={pending || advancing || !complete}>
              {submitted ? "Update review" : "Submit review"}
            </Button>
          </div>
        )}
      </form>
    </section>
  );
}

function CriterionInput({
  criterion,
  value,
  onChange,
}: {
  criterion: JudgingCriterionDto;
  value: number | undefined;
  onChange: (score: number) => void;
}) {
  const options = Array.from({ length: criterion.maxScore + 1 }, (_, index) => index);
  const name = `criterion-${criterion.id}`;
  return (
    <fieldset className="flex flex-col gap-2.5 rounded-lg border border-line bg-canvas p-4">
      <legend className="sr-only">{criterion.name}</legend>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p aria-hidden className="text-label text-ink">{criterion.name}</p>
        <p className="text-caption text-ink-muted">
          {value === undefined ? "Not scored" : `${value} / ${criterion.maxScore}`} · weight {criterion.weight}
        </p>
      </div>
      {criterion.description ? <p className="whitespace-pre-wrap text-body-ui text-ink-secondary">{criterion.description}</p> : null}
      <div className="flex flex-wrap gap-1.5">
        {options.map((score) => {
          const selected = value === score;
          return (
            <label
              key={score}
              className={cn(
                "relative inline-flex size-11 cursor-pointer items-center justify-center rounded-full border text-sm font-bold transition-colors",
                "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-[var(--yy-focus)]",
                "has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-70",
                selected ? "border-primary bg-primary text-on-primary" : "border-line-strong bg-canvas text-ink hover:bg-subtle",
              )}
            >
              <input
                type="radio"
                name={name}
                value={score}
                checked={selected}
                onChange={() => onChange(score)}
                className="sr-only"
              />
              {score}
              <span className="sr-only"> out of {criterion.maxScore}</span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
