"use client";

import { useEffect, useState } from "react";
import { assignApplicationReviewer, loadApplicationDetail, unassignApplicationReviewer } from "@/app/actions/admission";
import { Button } from "@/components/ui/button";
import { Dropdown, Field } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { OfferControls } from "./OfferControls";
import { useAdmissionAction, type AdmissionData, type AdmissionScope, type ApplicationRow, type StageRow } from "./shared";

type Detail = Extract<Awaited<ReturnType<typeof loadApplicationDetail>>, { ok: true }>["data"];

/**
 * One application, opened from the list: its people and answers, every
 * review (scores and notes, with reviewers named; organisers only), its
 * reviewers in the current stage, and the offer controls.
 */
export function ApplicationDetail({ scope, application, stages, reviewers }: { scope: AdmissionScope; application: ApplicationRow; stages: StageRow[]; reviewers: AdmissionData["reviewers"] }) {
  const { run, busy } = useAdmissionAction();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reviewer, setReviewer] = useState("");
  const stage = stages.find((row) => row.id === application.stageId);
  const pool = stage ? reviewers.filter((row) => (stage.panelUserIds.length ? stage.panelUserIds.includes(row.userId) : row.grantee)) : [];

  useEffect(() => {
    let current = true;
    loadApplicationDetail({ ...scope, applicationId: application.id }).then(
      (result) => current && (result.ok ? setDetail(result.data ?? null) : setError(result.error)),
      () => current && setError("The application didn't load. Try again."),
    );
    return () => {
      current = false;
    };
  }, [scope, application.id, application.status, application.counted]);

  return (
    <div className="mt-3 flex flex-col gap-4 rounded-[10px] border border-line bg-canvas p-4 text-body-ui">
      {error ? <p className="text-ink-muted">{error}</p> : null}
      {!detail && !error ? <Spinner /> : null}
      {detail ? (
        <>
          {detail.teamName ? <p className="font-semibold">Team {detail.teamName}</p> : null}
          {detail.people.map((person) => (
            <div key={person.rsvpId}>
              <p className="font-semibold">{person.name}{person.isLeader ? " (leader)" : ""}{person.email ? <span className="font-normal text-ink-muted"> · {person.email}</span> : null}</p>
              {person.answers.length ? (
                <dl className="mt-1 grid gap-1">
                  {person.answers.map((answer) => (
                    <div key={answer.fieldId}><dt className="text-caption text-ink-muted">{answer.label}</dt><dd className="whitespace-pre-wrap">{answer.value || "–"}</dd></div>
                  ))}
                </dl>
              ) : <p className="text-caption text-ink-muted">No answers.</p>}
            </div>
          ))}
          {detail.answerRevisions ? <p className="text-caption text-ink-muted">Answers changed {detail.answerRevisions} {detail.answerRevisions === 1 ? "time" : "times"}; only reviews of the current answers count.</p> : null}
          <div>
            <h4 className="text-label">Reviews</h4>
            {detail.reviews.length === 0 ? <p className="text-caption text-ink-muted">No reviews yet.</p> : (
              <ul className="mt-1 flex flex-col gap-2">
                {detail.reviews.map((review, index) => (
                  <li key={index}>
                    <span className="font-semibold">{review.reviewer}</span> · {review.stage} · {review.mean} / 5{review.current ? "" : " (earlier answers)"}
                    <span className="block text-caption text-ink-muted">{Object.entries(review.scores).map(([key, value]) => `${key}: ${value}`).join(", ")}</span>
                    {review.notes ? <span className="block whitespace-pre-wrap">{review.notes}</span> : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      ) : null}
      {application.status === "IN_REVIEW" && stage ? (
        <div>
          <h4 className="text-label">Reviewers in {stage.name}</h4>
          <ul className="mt-1 flex flex-col gap-1">
            {application.assigned.map((row) => (
              <li key={row.id} className="flex items-center gap-2">
                {row.reviewer}{row.reviewed ? " · reviewed" : ""}
                {!row.reviewed ? <Button size="sm" variant="quiet" loading={busy === row.id} onClick={() => run(row.id, () => unassignApplicationReviewer({ ...scope, assignmentId: row.id }), "Reviewer removed.")}>Remove</Button> : null}
              </li>
            ))}
          </ul>
          {pool.length ? (
            <div className="mt-2 flex flex-wrap items-end gap-2">
              <Field label="Add a reviewer">
                <Dropdown value={reviewer} onChange={(event) => setReviewer(event.target.value)}>
                  <option value="">Choose</option>
                  {pool.map((row) => <option key={row.userId} value={row.userId}>{row.name}</option>)}
                </Dropdown>
              </Field>
              <Button size="sm" disabled={!reviewer} loading={busy === "assign"} onClick={() => run("assign", () => assignApplicationReviewer({ ...scope, stageId: stage.id, applicationId: application.id, reviewerUserId: reviewer }), "Reviewer added.")}>Add</Button>
            </div>
          ) : null}
        </div>
      ) : null}
      <OfferControls scope={scope} application={application} paid={detail?.paid ?? false} />
    </div>
  );
}
