"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Callout } from "@/components/ui/display";
import { Field, Input } from "@/components/ui/field";
import type { DashboardTeam } from "@/lib/eventDashboard/teams";
import type { Result } from "./constants";

export function RenameTeamDialog({ team, onClose, onRename }: { team: DashboardTeam; onClose: () => void; onRename: (name: string) => Promise<Result> }) {
  const [name, setName] = useState(team.name);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <Dialog open onOpenChange={(next) => { if (!next && !pending) onClose(); }}>
      <DialogContent size="sm">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            startTransition(async () => {
              const res = await onRename(name);
              if (!res.ok) {
                setError(res.error);
                return;
              }
              onClose();
            });
          }}
        >
          <DialogHeader title="Rename team" description="Team names are unique within this event." />
          <DialogBody className="flex flex-col gap-4">
            {error ? <Callout tone="danger" role="alert">{error}</Callout> : null}
            <Field label="Team name" required>
              <Input value={name} maxLength={60} onChange={(event) => setName(event.target.value)} autoFocus />
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button variant="secondary" onClick={onClose} disabled={pending}>Cancel</Button>
            <Button type="submit" variant="primary" loading={pending} disabled={!name.trim() || name.trim() === team.name}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
