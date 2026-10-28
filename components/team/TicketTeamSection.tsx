"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Crown, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Avatar, Callout, Card, CardHeader, Chip } from "@/components/ui/display";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/field";
import { SwitchRow } from "@/components/ui/choice";
import { leaveTeamAction } from "@/app/actions/teams";
import { RSVP_STORAGE_PREFIX } from "@/components/rsvp/RsvpForm/helpers";
import { ShowMoreFooter } from "./useCursorList";
import { OtherSeekersList, TeamsLookingList } from "./TicketTeamSection/LookingLists";
import type { TicketSeekerPanelProps } from "./TicketTeamSection/types";
import { useSeekerPanel } from "./TicketTeamSection/useSeekerPanel";

/** Drop a cached RSVP marker for this ticket so event pages stop showing "registered". */
function forgetStoredTicket(token: string) {
  try {
    for (const key of Object.keys(localStorage)) {
      if (!key.startsWith(RSVP_STORAGE_PREFIX)) continue;
      try {
        const value = localStorage.getItem(key);
        const parsed = value ? (JSON.parse(value) as { ticketToken?: string }) : null;
        if (parsed?.ticketToken === token) localStorage.removeItem(key);
      } catch {
        // Ignore unreadable entries.
      }
    }
  } catch {
    // Storage unavailable (private mode, blocked site data).
  }
}

/**
 * A member's view of their team on the ticket page: names only, and the one
 * action the ticket token allows, leaving. Management lives on the team page.
 */
export function TicketTeamCard(props: {
  ticketToken: string;
  team: { name: string; leaderName: string | null; members: string[]; isLeader: boolean };
  /** Signed-in leaders get a link to the team page; guests use their emailed link. */
  manageHref: string | null;
  canLeave: boolean;
  eventPageHref: string;
}) {
  const { ticketToken, team, manageHref, canLeave, eventPageHref } = props;
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function leave() {
    setError(null);
    startTransition(async () => {
      const res = await leaveTeamAction(ticketToken);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      forgetStoredTicket(ticketToken);
      setOpen(false);
      router.push(eventPageHref);
      router.refresh();
    });
  }

  return (
    <Card as="section" aria-labelledby="ticket-team-title">
      <CardHeader
        titleAs="h2"
        title={<span id="ticket-team-title">{team.name}</span>}
        description={team.leaderName ? `Led by ${team.leaderName}` : "Your team"}
        action={<Chip tone="neutral" size="sm" icon={<Users />}>{team.members.length}</Chip>}
      />
      <ul className="flex flex-col gap-2.5" aria-label="Team members">
        {team.members.map((name, index) => (
          <li key={`${index}-${name}`} className="flex min-w-0 items-center gap-2.5">
            <Avatar name={name} size="xs" />
            <span className="truncate text-body-ui text-ink">{name}</span>
          </li>
        ))}
      </ul>

      {team.isLeader ? (
        <div className="mt-4 border-t border-line pt-4">
          {manageHref ? (
            <Button asChild variant="secondary" size="sm">
              <Link href={manageHref} prefetch={false}>
                <Crown aria-hidden className="size-4" />
                Manage team
              </Link>
            </Button>
          ) : (
            <p className="text-caption text-ink-muted">You lead this team. Manage it from the team link in your confirmation email.</p>
          )}
        </div>
      ) : null}

      {canLeave ? (
        <div className="mt-4 flex justify-center">
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="inline-flex min-h-10 items-center text-sm font-semibold text-ink-secondary underline underline-offset-4 hover:text-danger-fg"
          >
            Leave team
          </button>
        </div>
      ) : null}

      <ConfirmDialog
        open={open}
        title={`Leave ${team.name}?`}
        message={
          team.isLeader
            ? "Leaving cancels your registration for this event. Leadership passes to the member who joined first; if you're the only member, the team is deleted."
            : "Leaving cancels your registration for this event. You can register again on your own or join another team."
        }
        cancelLabel="Stay in team"
        confirmLabel={pending ? "Leaving…" : "Leave team"}
        loading={pending}
        onConfirm={leave}
        onCancel={() => setOpen(false)}
      >
        {error ? <Callout tone="danger" role="alert">{error}</Callout> : null}
      </ConfirmDialog>
    </Card>
  );
}

/**
 * Looking for a team (SOLO_WITH_MATCHING) on a solo registrant's ticket page:
 * their own profile, invitations to answer, their requests, and, while they
 * are listed, the other seekers and the teams looking for members.
 */
export function TicketSeekerPanel(props: TicketSeekerPanelProps) {
  const { profile, seekers, teams } = props;
  const s = useSeekerPanel(props);
  const {
    pending,
    busyId,
    feedback,
    editing,
    headline,
    setHeadline,
    skills,
    setSkills,
    visible,
    setVisible,
    errors,
    invites,
    requests,
    startEditing,
    cancelEditing,
    save,
    setListed,
    answerInvite,
    withdraw,
  } = s;

  return (
    <Card as="section" aria-labelledby="ticket-seeker-title">
      <CardHeader
        title={<span id="ticket-seeker-title">Looking for a team</span>}
        description="Other people at this event see only your first name, last initial, headline and skills."
      />

      {feedback ? (
        <Callout tone={feedback.tone} role={feedback.tone === "danger" ? "alert" : "status"} className="mb-4">{feedback.message}</Callout>
      ) : null}

      {invites.items.length || invites.total ? (
        <div className="mb-5">
          <h3 className="text-label text-ink">
            Invitations <span className="font-normal text-ink-muted">· {invites.total}</span>
          </h3>
          {invites.error ? <Callout tone="danger" role="alert" className="mt-2">{invites.error}</Callout> : null}
          <ul className="mt-2 flex flex-col divide-y divide-line" id={invites.listId}>
            {invites.items.map((invite) => (
              <li key={invite.id} className="flex flex-col gap-2 py-3 first:pt-0">
                <p className="min-w-0 text-body-ui text-ink">
                  <span className="font-semibold">{invite.teamName}</span>
                  <span className="text-ink-muted"> · {invite.maxSize != null ? `${invite.size} of ${invite.maxSize}` : invite.size} members</span>
                </p>
                <div className="flex gap-2">
                  <Button variant="primary" size="sm" loading={busyId === invite.id} disabled={pending} onClick={() => answerInvite(invite.id, true)}>Join team</Button>
                  <Button variant="secondary" size="sm" disabled={pending} onClick={() => answerInvite(invite.id, false)}>Decline</Button>
                </div>
              </li>
            ))}
          </ul>
          <ShowMoreFooter
            shown={invites.items.length}
            total={invites.total}
            hasMore={invites.nextCursor != null}
            loading={invites.loading === "more"}
            onMore={invites.loadMore}
          />
        </div>
      ) : null}

      {editing ? (
        <form onSubmit={save} className="flex flex-col gap-3.5" noValidate>
          <Field label="Headline" helperText="What you're good at or want to work on, up to 120 characters." error={errors.headline?.[0]}>
            <Input value={headline} onChange={(e) => setHeadline(e.target.value)} maxLength={120} autoComplete="off" required />
          </Field>
          <Field label="Skills" optional helperText="Separate with commas. Up to 8, each up to 30 characters." error={errors.skills?.[0]}>
            <Input value={skills} onChange={(e) => setSkills(e.target.value)} autoComplete="off" maxLength={280} />
          </Field>
          <SwitchRow label="Show me on the list" description="Turn off to hide yourself without losing your details." checked={visible} onCheckedChange={setVisible} />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="primary" size="sm" loading={busyId === "profile"} loadingLabel="Saving…">
              {profile ? "Save" : "List me"}
            </Button>
            {profile ? <Button variant="quiet" size="sm" onClick={cancelEditing}>Cancel</Button> : null}
          </div>
        </form>
      ) : profile ? (
        <div className="flex flex-col gap-3">
          <div className="min-w-0">
            <p className="break-words text-body-ui text-ink">{profile.headline}</p>
            {profile.skills.length ? (
              <ul className="mt-1.5 flex flex-wrap gap-1.5" aria-label="Your skills">
                {profile.skills.map((skill) => <li key={skill}><Chip tone="outline" size="sm">{skill}</Chip></li>)}
              </ul>
            ) : null}
          </div>
          <SwitchRow label="Show me on the list" checked={profile.visible} disabled={pending} onCheckedChange={setListed} />
          <div>
            <Button variant="secondary" size="sm" onClick={startEditing}>Edit details</Button>
          </div>
        </div>
      ) : null}

      {requests.items.length || requests.total ? (
        <div className="mt-5 border-t border-line pt-5">
          <h3 className="text-label text-ink">
            Your requests <span className="font-normal text-ink-muted">· {requests.total}</span>
          </h3>
          {requests.error ? <Callout tone="danger" role="alert" className="mt-2">{requests.error}</Callout> : null}
          <ul className="mt-2 flex flex-col divide-y divide-line" id={requests.listId}>
            {requests.items.map((request) => (
              <li key={request.id} className="flex items-center justify-between gap-3 py-2.5">
                <span className="min-w-0 truncate text-body-ui text-ink">{request.teamName}</span>
                <Button variant="quiet" size="sm" loading={busyId === request.id} disabled={pending} onClick={() => withdraw(request.id)}>Withdraw</Button>
              </li>
            ))}
          </ul>
          <ShowMoreFooter
            shown={requests.items.length}
            total={requests.total}
            hasMore={requests.nextCursor != null}
            loading={requests.loading === "more"}
            onMore={requests.loadMore}
          />
        </div>
      ) : null}

      {teams ? <TeamsLookingList s={s} /> : null}

      {seekers ? <OtherSeekersList s={s} /> : null}
    </Card>
  );
}
