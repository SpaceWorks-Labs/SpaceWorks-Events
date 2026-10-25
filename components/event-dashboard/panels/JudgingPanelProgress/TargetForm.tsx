"use client";

import { useState } from "react";
import { saveReviewsPerProject } from "@/app/actions/judging-ops";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { DEFAULT_REVIEWS_PER_PROJECT, REVIEWS_PER_PROJECT_MAX, REVIEWS_PER_PROJECT_MIN } from "@/lib/judgingProgress";
import { useJudgingAction, type JudgingScope } from "../JudgingPanelShared";

export function TargetForm({ scope, reviewsPerProject }: { scope: JudgingScope; reviewsPerProject: number | null }) {
  const [value, setValue] = useState(reviewsPerProject == null ? "" : String(reviewsPerProject));
  const [error, setError] = useState<string | undefined>();
  const { run, busy } = useJudgingAction();
  const saved = reviewsPerProject == null ? "" : String(reviewsPerProject);
  return (
    <form
      className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end"
      onSubmit={(event) => {
        event.preventDefault();
        setError(undefined);
        run(
          "target",
          () => saveReviewsPerProject({ ...scope, reviewsPerProject: value.trim() === "" ? null : value.trim() }),
          "Review target saved.",
          (result) => {
            if (!result.ok) setError(result.fieldErrors?.reviewsPerProject?.[0] ?? result.error);
          },
        );
      }}
    >
      <Field
        label="Target judges per project"
        helperText={`Leave empty for the default of ${DEFAULT_REVIEWS_PER_PROJECT}.`}
        error={error}
        className="sm:max-w-[260px]"
      >
        <Input
          type="number"
          inputMode="numeric"
          min={REVIEWS_PER_PROJECT_MIN}
          max={REVIEWS_PER_PROJECT_MAX}
          step={1}
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
      </Field>
      <Button type="submit" variant="secondary" loading={busy === "target"} loadingLabel="Saving…" disabled={value.trim() === saved} className="sm:mb-[22px]">
        Save target
      </Button>
    </form>
  );
}
