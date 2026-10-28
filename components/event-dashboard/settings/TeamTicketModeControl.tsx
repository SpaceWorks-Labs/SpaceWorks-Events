"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { saveTeamTicketMode } from "@/app/actions/ticket-types";
import { useToast } from "@/components/feedback/ToastProvider";
import { Button } from "@/components/ui/button";
import { Radio, RadioGroup } from "@/components/ui/choice";
import { Card, CardHeader } from "@/components/ui/display";

type Mode = "PER_MEMBER" | "PER_TEAM";

/** Who pays on a team event that sells tickets (docs/TEAMS.md). Fixed once a ticket is sold. */
export function TeamTicketModeControl({ organisationSlug, eventId, mode, sold }: { organisationSlug: string; eventId: string; mode: Mode; sold: boolean; }) {
  const router = useRouter();
  const { showToast } = useToast();
  const [value, setValue] = useState<Mode>(mode);
  const [pending, startTransition] = useTransition();
  return (
    <Card as="section" className="rounded-xl" aria-labelledby="team-ticket-mode-title">
      <CardHeader
        title={<span id="team-ticket-mode-title">Who pays for teams</span>}
        description={sold ? "Tickets have been sold, so this can no longer change." : "Each ticket seats one person. Choose whether every member buys their own, or the leader buys one for the whole team."}
      />
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          startTransition(async () => {
            const result = await saveTeamTicketMode({ organisationSlug, eventId, mode: value });
            if (!result.ok) return showToast(result.error, "error");
            showToast("Saved.", "success");
            router.refresh();
          });
        }}
      >
        <RadioGroup value={value} onValueChange={(next) => setValue(next as Mode)} aria-label="Who pays for teams" disabled={sold}>
          <Radio value="PER_MEMBER" label="Every member" description="The leader buys a ticket when creating the team; members buy theirs when they join." />
          <Radio value="PER_TEAM" label="The leader, once per team" description="The leader's ticket covers the whole team; members join free once it's paid." />
        </RadioGroup>
        {sold ? null : <div><Button type="submit" loading={pending} loadingLabel="Saving…" disabled={value === mode}>Save</Button></div>}
      </form>
    </Card>
  );
}
