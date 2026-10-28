"use client";

import Link from "next/link";
import { Check, Copy, RefreshCw, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout, Card, CardHeader, Chip, DangerZone, EmptyState } from "@/components/ui/display";
import { ConfirmDialog, Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Field, Input, ReadOnlyValue } from "@/components/ui/field";
import { MatchingCard } from "./TeamManager/MatchingCard";
import { MembersCard } from "./TeamManager/MembersCard";
import type { Confirm, TeamManagerProps } from "./TeamManager/types";
import { useTeamManager } from "./TeamManager/useTeamManager";

export type { TeamManagerMember, TeamManagerProps, TeamManagerRequest, TeamManagerSeeker } from "./TeamManager/types";

/**
 * The leader's team page. Every button calls a Server Action that re-checks
 * the management capability under the event lock; nothing here decides
 * permissions. Member rows carry names only.
 */
export function TeamManager(props: TeamManagerProps) {
  const { tokenPage, baseUrl, team, event, members, seekers, submissionSlot } = props;
  const m = useTeamManager(props);
  const {
    pending,
    feedback,
    confirm,
    setConfirm,
    confirmError,
    finished,
    copied,
    renameOpen,
    setRenameOpen,
    renameValue,
    setRenameValue,
    renameError,
    setRenameError,
    busyId,
    status,
    rejected,
    copyJoinLink,
    closeConfirm,
    confirmAction,
    submitRename,
  } = m;

  if (finished) {
    return (
      <EmptyState
        mood="done"
        title={finished.title}
        action={finished.eventPath ? <Button asChild variant="secondary"><Link href={finished.eventPath}>Event page</Link></Button> : undefined}
      >
        {finished.body}
      </EmptyState>
    );
  }

  const confirmCopy: Record<NonNullable<Confirm>["kind"], { title: string; message: string; label: string; destructive: boolean }> = {
    remove: {
      title: confirm?.kind === "remove" ? `Remove ${confirm.member.name}?` : "Remove member?",
      message: "Their registration for this event is cancelled. They can register again on their own or join another team.",
      label: "Remove",
      destructive: true,
    },
    transfer: {
      title: confirm?.kind === "transfer" ? `Make ${confirm.member.name} the leader?` : "Transfer leadership?",
      message: "They get a new team link by email and this page stops working for you. You stay in the team as a member.",
      label: "Transfer leadership",
      destructive: false,
    },
    rotateJoin: {
      title: "Create a new join link?",
      message: "The current join link stops working straight away. Share the new one with anyone who still needs to join.",
      label: "Create new link",
      destructive: false,
    },
    rotateManage: {
      title: "Reset the team management link?",
      message: "The link you used to open this page stops working, including the one in your email. You'll move to the new address, and we'll email it to the team leader.",
      label: "Reset link",
      destructive: false,
    },
    disband: {
      title: `Disband ${team.name}?`,
      message: `This cancels the registration of all ${team.size} ${team.size === 1 ? "member" : "members"} and deletes the team. This can't be undone.`,
      label: "Disband team",
      destructive: true,
    },
  };
  const confirmText = confirm ? confirmCopy[confirm.kind] : null;

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-3">
        <Link href={event.href} className="text-sm font-semibold text-ink-secondary hover:text-ink">
          {event.title}
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-overline text-ink-muted">Your team</p>
            <h1 className="break-words font-display text-[30px] font-extrabold leading-tight tracking-[-0.02em] text-ink sm:text-[38px]">{team.name}</h1>
            <p className="mt-1 text-body-ui text-ink-muted">{event.whenLabel}</p>
          </div>
          {/* A declined team can only be viewed, trimmed or disbanded; the cores refuse the rest too. */}
          {!rejected ? (
            <Button variant="secondary" size="sm" onClick={() => { setRenameValue(team.name); setRenameError(null); setRenameOpen(true); }}>
              Rename
            </Button>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Chip tone={status.tone} icon={team.status === "CONFIRMED" ? <Check /> : undefined}>{status.label}</Chip>
          <Chip tone="neutral" icon={<Users />}>
            {team.maxSize != null ? `${team.size} of ${team.maxSize} members` : `${team.size} ${team.size === 1 ? "member" : "members"}`}
          </Chip>
          {team.incomplete ? <Chip tone="warning">Incomplete</Chip> : null}
        </div>
      </header>

      {team.incomplete && team.minSize != null ? (
        <Callout tone="warning">
          Teams need at least {team.minSize} members.{" "}
          {team.status === "PENDING_APPROVAL"
            ? `The organisers can't approve your team until it has ${team.minSize}.`
            : `Add ${Math.max(1, team.minSize - team.size)} more with the join link so your team is complete.`}
        </Callout>
      ) : null}
      {rejected ? (
        <Callout tone="danger">
          The organisers declined this team, so it can&apos;t take new members or be changed. You can still remove members or disband the team.
        </Callout>
      ) : null}

      {feedback ? (
        <Callout tone={feedback.tone} role={feedback.tone === "danger" ? "alert" : "status"}>{feedback.message}</Callout>
      ) : null}

      {!rejected ? (
        <Card as="section" aria-labelledby="team-join-link">
          <CardHeader
            title={<span id="team-join-link">Join link</span>}
            description="Anyone with this link can register straight into your team. It shows the team name and size, never who is in it."
          />
          <ReadOnlyValue
            value={<span className="font-mono text-sm">{`${baseUrl}${team.joinPath}`}</span>}
            action={
              <Button variant="quiet" size="sm" onClick={copyJoinLink} aria-live="polite">
                {copied ? <Check aria-hidden className="size-4" /> : <Copy aria-hidden className="size-4" />}
                {copied ? "Copied" : "Copy"}
              </Button>
            }
          />
          <div className="mt-3">
            <Button variant="quiet" size="sm" onClick={() => setConfirm({ kind: "rotateJoin" })}>
              <RefreshCw aria-hidden className="size-4" />
              Create a new link…
            </Button>
          </div>
        </Card>
      ) : null}

      <MembersCard members={members} event={event} m={m} />

      {submissionSlot ?? null}

      {event.matching && !rejected ? <MatchingCard team={team} seekers={seekers} m={m} /> : null}

      {tokenPage && !rejected ? (
        <Card as="section" aria-labelledby="team-manage-link">
          <CardHeader
            title={<span id="team-manage-link">This page&apos;s link</span>}
            description="Anyone with the link to this page can manage your team. If it may have been shared, reset it."
          />
          <Button variant="secondary" size="sm" onClick={() => setConfirm({ kind: "rotateManage" })}>
            <RefreshCw aria-hidden className="size-4" />
            Reset management link…
          </Button>
        </Card>
      ) : null}

      <DangerZone
        title="Disband team"
        description="Cancels everyone's registration and deletes the team."
        action={<Button variant="danger" onClick={() => setConfirm({ kind: "disband" })}>Disband team…</Button>}
      />

      <ConfirmDialog
        open={confirm !== null}
        title={confirmText?.title ?? ""}
        message={confirmText?.message}
        confirmLabel={confirmText?.label}
        destructive={confirmText?.destructive ?? true}
        loading={pending && busyId === null}
        confirmText={confirm?.kind === "disband" ? team.name : undefined}
        onConfirm={confirmAction}
        onCancel={closeConfirm}
      >
        {confirmError ? <Callout tone="danger" role="alert">{confirmError}</Callout> : null}
      </ConfirmDialog>

      <Dialog open={renameOpen} onOpenChange={(open) => !pending && setRenameOpen(open)}>
        <DialogContent size="sm">
          <form onSubmit={submitRename} noValidate>
            <DialogHeader title="Rename team" description="Team names are unique for this event." />
            <DialogBody>
              <Field label="Team name" error={renameError ?? undefined}>
                <Input value={renameValue} onChange={(e) => setRenameValue(e.target.value)} maxLength={60} autoComplete="off" autoFocus required />
              </Field>
            </DialogBody>
            <DialogFooter>
              <Button variant="secondary" onClick={() => setRenameOpen(false)} disabled={pending}>Cancel</Button>
              <Button type="submit" variant="primary" loading={pending} loadingLabel="Saving…">Save</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
