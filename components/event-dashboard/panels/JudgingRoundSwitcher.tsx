"use client";

import type { JudgingStatus } from "@prisma/client";
import { Dropdown, Field } from "@/components/ui/field";
import { roundOptionLabel } from "./judgingRoundsCopy";

export type JudgingRoundOption = { id: string; name: string; position: number; judgingStatus: JudgingStatus; isCurrent: boolean };

/**
 * "Round" picker above Score, Progress and Results (docs/HACKATHON.md
 * "Rounds"). Shown only when the event has more than one round; the current
 * round (the one judges score) is the default.
 */
export function JudgingRoundSwitcher({
  rounds,
  value,
  onChange,
  disabled,
}: {
  rounds: readonly JudgingRoundOption[];
  value: string;
  onChange: (roundId: string) => void;
  disabled?: boolean;
}) {
  if (rounds.length < 2) return null;
  return (
    <Field label="Round" className="max-w-sm">
      <Dropdown value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
        {rounds.map((round) => (
          <option key={round.id} value={round.id}>
            {roundOptionLabel(round)}
          </option>
        ))}
      </Dropdown>
    </Field>
  );
}
