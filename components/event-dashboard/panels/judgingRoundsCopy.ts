import type { JudgingRoundEntrySource, JudgingRoundStatus, JudgingStatus } from "@prisma/client";
import type { ChipTone } from "@/components/ui/display";

/*
 * Copy for Judging → Rounds and the round switchers (docs/HACKATHON.md
 * "Rounds"). Pure, so it is unit tested (tests/unit/judging-rounds-copy.test.ts).
 */

const STATUS: Record<JudgingStatus, string> = { NOT_STARTED: "Not started", OPEN: "Open", CLOSED: "Closed" };

/** "2. Finals · Open (current)" */
export function roundOptionLabel(round: { name: string; position: number; judgingStatus: JudgingStatus; isCurrent: boolean }): string {
  return `${round.position}. ${round.name} · ${STATUS[round.judgingStatus]}${round.isCurrent ? " (current)" : ""}`;
}

export const ROUND_STATUS_LABELS: Record<JudgingRoundStatus, string> = { DRAFT: "Draft", OPEN: "Open", CLOSED: "Closed" };
export const ROUND_STATUS_TONES: Record<JudgingRoundStatus, ChipTone> = { DRAFT: "neutral", OPEN: "success", CLOSED: "ink" };

/** Status pill text: always a word, "Finalised" once a closed round is finalised. */
export function roundStatusLabel(round: { status: JudgingRoundStatus; finalizedAt: string | null }): string {
  return round.finalizedAt ? "Finalised" : ROUND_STATUS_LABELS[round.status];
}

export function entrySourceLine(round: { entrySource: JudgingRoundEntrySource; finalists: number; position: number }): string {
  if (round.entrySource === "ALL_SUBMITTED") return "Judges every submitted project";
  if (round.finalists === 0) return "Judges finalists from the previous round: none advanced yet";
  return `Judges ${round.finalists} ${round.finalists === 1 ? "finalist" : "finalists"} from the previous round`;
}

/** Who judges the round: its own panel, or (no panel) everyone who can judge the event. */
export function panelLine(panelSize: number): string {
  if (panelSize === 0) return "Panel: all invited judges (no panel chosen)";
  return `Panel: ${panelSize} chosen ${panelSize === 1 ? "judge" : "judges"}`;
}

/** The next status step offered for a round, or null when none applies. */
export function nextRoundAction(round: { status: JudgingRoundStatus; finalizedAt: string | null }): { status: JudgingRoundStatus; label: string } | null {
  if (round.finalizedAt) return null;
  if (round.status === "DRAFT") return { status: "OPEN", label: "Open round" };
  if (round.status === "OPEN") return { status: "CLOSED", label: "Close round" };
  return { status: "OPEN", label: "Reopen round" };
}

/** Advancement preview summary. */
export function advanceSummary(preview: { added: number; removed: number; kept: number; finalists: number }): string {
  const parts = [`${preview.finalists} ${preview.finalists === 1 ? "finalist" : "finalists"}`];
  if (preview.added) parts.push(`${preview.added} new`);
  if (preview.kept) parts.push(`${preview.kept} already in`);
  if (preview.removed) parts.push(`${preview.removed} removed`);
  return parts.join(" · ");
}

/** Round switcher options from the Rounds data, in order, with each round's rubric. */
export function roundOptions<C>(rounds: ReadonlyArray<{ id: string; name: string; position: number; status: JudgingRoundStatus; isCurrent: boolean; criteria: C[] }>) {
  return rounds.map((round) => ({
    id: round.id,
    name: round.name,
    position: round.position,
    judgingStatus: (round.status === "DRAFT" ? "NOT_STARTED" : round.status) as JudgingStatus,
    isCurrent: round.isCurrent,
    criteria: round.criteria,
  }));
}
