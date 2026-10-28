"use client";

import { useState } from "react";
import { loadJudgeWorkspaceRound } from "@/app/actions/judging";
import { Callout } from "@/components/ui/display";
import { Spinner } from "@/components/ui/spinner";
import { JudgingRoundSwitcher } from "@/components/event-dashboard/panels/JudgingRoundSwitcher";
import type { JudgeRoundDto, JudgeWorkspaceDto } from "@/lib/judgingDto";
import { JudgeWorkspaceClient } from "./JudgeWorkspaceClient";
import { RecusedProjects } from "./JudgeWorkspaceClient/Recusal";
import type { WorkspaceAudience } from "./judgeProgress";

/**
 * The judge workspace with its round switcher (docs/HACKATHON.md "Rounds").
 * It opens on the current round, the only one judges score; another round
 * loads read-only through `loadJudgeWorkspaceRound` with the same visibility
 * rules for that round. With a single round nothing changes.
 */
export function JudgeWorkspaceRounds({
  organisationSlug,
  eventId,
  audience,
  workspace,
}: {
  organisationSlug: string;
  eventId: string;
  audience: WorkspaceAudience;
  workspace: JudgeWorkspaceDto;
}) {
  const current = workspace.round?.id ?? "";
  const [picked, setPicked] = useState(current);
  const [other, setOther] = useState<JudgeWorkspaceDto | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pick(roundId: string) {
    setPicked(roundId);
    setError(null);
    if (roundId === current) return;
    setLoading(true);
    const result = await loadJudgeWorkspaceRound({ organisationSlug, eventId, roundId });
    setLoading(false);
    if (!result.ok || !result.data) setError(result.ok ? "Could not load that round." : result.error);
    else setOther(result.data);
  }

  const shown = picked !== current && other?.round?.id === picked ? other : picked === current ? workspace : null;
  const rounds: JudgeRoundDto[] = workspace.rounds;
  return (
    <div className="flex flex-col gap-5">
      <JudgingRoundSwitcher rounds={rounds} value={picked} onChange={(id) => void pick(id)} disabled={loading} />
      {error ? (
        <Callout tone="danger" role="alert">
          {error}
        </Callout>
      ) : null}
      {shown && !shown.onPanel ? (
        <Callout tone="info">This round has its own judging panel and you aren&apos;t on it, so there is nothing for you to score here.</Callout>
      ) : null}
      {loading ? (
        <div className="flex justify-center py-6">
          <Spinner className="size-5" />
          <span className="sr-only">Loading the round</span>
        </div>
      ) : shown ? (
        <JudgeWorkspaceClient
          key={shown.round?.id ?? "current"}
          organisationSlug={organisationSlug}
          eventId={eventId}
          roundId={shown === workspace ? null : picked}
          audience={audience}
          judgingStatus={shown.judgingStatus}
          criteria={shown.criteria}
          initialPage={{ submissions: shown.submissions, nextCursor: shown.nextCursor, counts: shown.counts }}
        />
      ) : null}
      {shown && !loading ? (
        <RecusedProjects scope={{ organisationSlug, eventId }} recusals={shown.recusals} canUndo={shown === workspace && shown.judgingStatus === "OPEN"} />
      ) : null}
    </div>
  );
}
