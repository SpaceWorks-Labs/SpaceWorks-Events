"use client";

import { Card, CardHeader, EmptyState, ProgressBar } from "@/components/ui/display";
import { TBody, TD, TH, THead, TR, Table } from "@/components/ui/table";
import type { JudgingDashboardJudge } from "@/lib/eventDashboard/judging";
import { OpenTabButton } from "../../EventDashboardTabs";

/**
 * Judging → Judges: the judges invited with the Judge permission, then the
 * organisation owners and admins who can also judge, each with how many
 * projects they see and their submitted reviews. Organisers are listed apart
 * so an event with no invited judges still says so.
 */
export function JudgingPanelJudges({ judges, judgesSeeAll }: { judges: JudgingDashboardJudge[]; judgesSeeAll: boolean }) {
  const invited = judges.filter((judge) => judge.kind === "judge");
  const organisers = judges.filter((judge) => judge.kind === "admin");
  return (
    <div className="flex flex-col gap-5">
      <Card as="section">
        <CardHeader
          title="Invited judges"
          description="Collaborators you invite with the Judge permission in Settings. Judges never see entrant emails or answers, and never see a project they're registered on."
        />
        {invited.length === 0 ? (
          <EmptyState title="No judges invited yet">
            Invite collaborators with the Judge permission from the{" "}
            <OpenTabButton tab="settings" className="font-semibold text-ink underline underline-offset-2 hover:text-ink-secondary">
              Settings tab
            </OpenTabButton>
            . Until then, organisers can judge themselves.
          </EmptyState>
        ) : (
          <JudgesTable label="Invited judges' progress" judges={invited} judgesSeeAll={judgesSeeAll} />
        )}
      </Card>
      {organisers.length > 0 ? (
        <Card as="section">
          <CardHeader title="Organisers who can also judge" description="Organisation owners and admins can score projects from the Score tab, under the same rules as invited judges." />
          <JudgesTable label="Organisers' judging progress" judges={organisers} judgesSeeAll={judgesSeeAll} />
        </Card>
      ) : null}
    </div>
  );
}

function JudgesTable({ label, judges, judgesSeeAll }: { label: string; judges: JudgingDashboardJudge[]; judgesSeeAll: boolean }) {
  return (
    <Table label={label}>
      <THead>
        <tr>
          <TH>Judge</TH>
          {judgesSeeAll ? null : <TH className="text-right">Assigned</TH>}
          <TH className="min-w-[180px]">Reviews submitted</TH>
        </tr>
      </THead>
      <TBody>
        {judges.map((judge) => (
          <TR key={judge.userId}>
            <TD>
              <span className="block font-semibold">{judge.name}</span>
              <span className="block text-caption text-ink-muted">
                {judge.kind === "admin" ? "Organiser" : "Judge"}
                {judge.email ? ` · ${judge.email}` : ""}
              </span>
            </TD>
            {judgesSeeAll ? null : <TD className="text-right tabular-nums">{judge.assigned}</TD>}
            <TD>
              {judge.visible == null ? (
                <span className="text-caption text-ink-muted">Not judging yet</span>
              ) : (
                <div className="flex items-center gap-3">
                  <ProgressBar value={judge.reviewsSubmitted} max={Math.max(judge.visible, 1)} tone="success" className="w-24" label={`${judge.reviewsSubmitted} of ${judge.visible} reviews submitted`} />
                  <span className="text-caption tabular-nums text-ink-secondary">
                    {judge.reviewsSubmitted} / {judge.visible}
                  </span>
                </div>
              )}
            </TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );
}
