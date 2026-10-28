"use client";

import { useState } from "react";
import { loadApplicationReview, recuseFromApplication, submitApplicationReview } from "@/app/actions/admission-applicant";
import type { ReviewItem, ReviewQueueItem } from "@/lib/admission/reviews";
import { Button } from "@/components/ui/button";
import { RadioCard, RadioGroup } from "@/components/ui/choice";
import { Chip, EmptyState } from "@/components/ui/display";
import { Field, Textarea } from "@/components/ui/field";
import { useAdmissionAction, type AdmissionScope } from "./shared";

const SCORES = ["1", "2", "3", "4", "5"];

/** The reviewer's queue and the review form for the application they open. */
export function ReviewQueue({ scope, items }: { scope: AdmissionScope; items: ReviewQueueItem[] }) {
  const { run, busy } = useAdmissionAction();
  const [open, setOpen] = useState<ReviewItem | null>(null);
  const [scores, setScores] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState("");

  if (items.length === 0) return <EmptyState title="Nothing to review">Applications assigned to you appear here.</EmptyState>;
  const show = (assignmentId: string) => run(`open:${assignmentId}`, () => loadApplicationReview({ ...scope, assignmentId }), null, (result) => {
    if (result.ok) {
      setOpen((result as { data: ReviewItem }).data);
      setScores({});
      setNotes("");
    }
  });

  return (
    <div className="mt-4 flex flex-col gap-4">
      <ul className="flex flex-col gap-2">
        {items.map((item) => (
          <li key={item.assignmentId} className="flex flex-wrap items-center justify-between gap-2 rounded-[10px] border border-line p-3">
            <span><span className="font-semibold">{item.label}</span> <span className="text-caption text-ink-muted">· {item.stageName}</span></span>
            <span className="flex items-center gap-2">
              <Chip size="sm" tone={item.reviewedCurrent ? "success" : item.stageOpen ? "info" : "neutral"}>{item.reviewedCurrent ? "Reviewed" : item.stageOpen ? "To review" : "Stage not open"}</Chip>
              <Button size="sm" variant="secondary" loading={busy === `open:${item.assignmentId}`} onClick={() => show(item.assignmentId)}>Open</Button>
            </span>
          </li>
        ))}
      </ul>
      {open ? (
        <section aria-label="Application" className="flex flex-col gap-4 rounded-[10px] border border-line bg-canvas p-4">
          <h3 className="text-label">{open.teamName ? `Team ${open.teamName}` : open.blind ? "Application (blind review)" : "Application"} · {open.stageName}</h3>
          {open.guidance ? <p className="whitespace-pre-wrap text-body-ui text-ink-muted">{open.guidance}</p> : null}
          {open.people.map((person) => (
            <div key={person.rsvpId}>
              <p className="font-semibold">{person.name}{person.isLeader ? " (leader)" : ""}</p>
              <dl className="mt-1 grid gap-1">
                {person.answers.map((answer) => <div key={answer.fieldId}><dt className="text-caption text-ink-muted">{answer.label}</dt><dd className="whitespace-pre-wrap">{answer.value || "–"}</dd></div>)}
              </dl>
            </div>
          ))}
          {open.reviewed ? (
            <p className="text-body-ui">You reviewed this: {Object.entries(open.reviewed.scores).map(([key, value]) => `${key === "overall" ? "Overall" : key} ${value}`).join(", ")}.</p>
          ) : open.canReview ? (
            <form
              className="flex flex-col gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                const numeric = Object.fromEntries(Object.entries(scores).map(([key, value]) => [key, Number(value)]));
                run("submit", () => submitApplicationReview({ ...scope, assignmentId: open.assignmentId, scores: numeric, notes }), "Review submitted.", (result) => result.ok && setOpen(null));
              }}
            >
              {open.criteria.map((criterion) => (
                <Field key={criterion} label={criterion === "overall" ? "Overall" : criterion} helperText="1 is weakest, 5 is strongest.">
                  <RadioGroup className="flex gap-2" value={scores[criterion] ?? ""} onValueChange={(value) => setScores((current) => ({ ...current, [criterion]: value }))}>
                    {SCORES.map((value) => <RadioCard key={value} value={value} label={value} />)}
                  </RadioGroup>
                </Field>
              ))}
              <Field label="Notes for the organisers" optional><Textarea rows={3} maxLength={2000} value={notes} onChange={(event) => setNotes(event.target.value)} /></Field>
              <div className="flex flex-wrap gap-2">
                <Button type="submit" variant="primary" disabled={open.criteria.some((criterion) => !scores[criterion])} loading={busy === "submit"}>Submit review</Button>
                <Button type="button" variant="quiet" loading={busy === "recuse"} onClick={() => run("recuse", () => recuseFromApplication({ ...scope, assignmentId: open.assignmentId }), "You stepped back. Someone else on the panel will review it.", (result) => result.ok && setOpen(null))}>
                  I have a conflict of interest
                </Button>
              </div>
            </form>
          ) : (
            <p className="text-body-ui text-ink-muted">This stage isn&apos;t open for reviews, or the application has moved on.</p>
          )}
        </section>
      ) : null}
    </div>
  );
}
