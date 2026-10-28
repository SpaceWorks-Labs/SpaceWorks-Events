"use client";

import { ArrowRightLeft, Crown, MoreHorizontal, Pencil, Trash2, UserMinus, UserX } from "lucide-react";
import { approveTeam, promoteTeam } from "@/app/actions/team-admin";
import { Button, IconButton } from "@/components/ui/button";
import { Avatar, Chip } from "@/components/ui/display";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import type { DashboardTeam } from "@/lib/eventDashboard/teams";
import { GUEST_STATUS_LABELS } from "@/components/event-dashboard/guests/guestList";
import { teamCheckInLabel, teamSizeLabel } from "@/components/event-dashboard/guests/teamList";
import { CHIP_TONES, type Member, type Result } from "./constants";

/** One team card: status, approve/place actions, the team menu and its members. */
export function TeamRow({
  team,
  pending,
  busyId,
  scope,
  run,
  setDeclining,
  setDeleting,
  setRenaming,
  setMoving,
  setRemoving,
}: {
  team: DashboardTeam;
  pending: boolean;
  busyId: string | null;
  scope: { organisationSlug: string; eventId: string };
  run: (id: string, action: () => Promise<Result>, success: string) => void;
  setDeclining: (team: DashboardTeam) => void;
  setDeleting: (team: DashboardTeam) => void;
  setRenaming: (team: DashboardTeam) => void;
  setMoving: (target: { member: Member; team: DashboardTeam }) => void;
  setRemoving: (target: { member: Member; team: DashboardTeam }) => void;
}) {
  const busy = pending && busyId === team.id;
  const checkIn = teamCheckInLabel(team);
  return (
    <li key={team.id} className="flex min-w-0 flex-col gap-3 rounded-xl border border-line bg-canvas px-4 py-3.5">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-[1_1_220px] flex-col">
          <span className="truncate font-bold text-ink">{team.name}</span>
          <span className="truncate text-caption text-ink-muted">
            {teamSizeLabel(team)}
            {checkIn ? ` · ${checkIn}` : ""}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Chip size="sm" tone={CHIP_TONES[team.status]}>{GUEST_STATUS_LABELS[team.status]}</Chip>
          {team.incomplete ? <Chip size="sm" tone="outline">Incomplete</Chip> : null}
          {team.lookingForMembers ? <Chip size="sm" tone="accent">Looking for members</Chip> : null}
        </div>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
          {team.status === "PENDING_APPROVAL" ? (
            <>
              <Button
                size="sm"
                variant="secondary"
                disabled={pending}
                loading={busy}
                // Incomplete teams keep a focusable, aria-disabled button so keyboard
                // and screen-reader users reach the reason it is unavailable.
                aria-disabled={team.incomplete || undefined}
                aria-describedby={team.incomplete ? `team-approve-reason-${team.id}` : undefined}
                onClick={() => {
                  if (team.incomplete) return;
                  run(team.id, () => approveTeam({ ...scope, teamId: team.id }), `${team.name} approved`);
                }}
                aria-label={`Approve team ${team.name}`}
              >
                Approve
              </Button>
              <Button size="sm" variant="dangerQuiet" disabled={pending} onClick={() => setDeclining(team)} aria-label={`Decline team ${team.name}`}>
                Decline
              </Button>
            </>
          ) : null}
          {team.status === "WAITLISTED" ? (
            <Button size="sm" variant="secondary" disabled={pending} loading={busy} onClick={() => run(team.id, () => promoteTeam({ ...scope, teamId: team.id }), `${team.name} has a place`)} aria-label={`Give team ${team.name} a place`}>
              Give a place
            </Button>
          ) : null}
          <Menu>
            <MenuTrigger asChild>
              <IconButton size="sm" variant="secondary" label={`More actions for team ${team.name}`} disabled={pending}>
                <MoreHorizontal />
              </IconButton>
            </MenuTrigger>
            <MenuContent>
              <MenuItem icon={<Pencil />} onSelect={() => setRenaming(team)}>
                Rename team
              </MenuItem>
              {team.status === "WAITLISTED" ? (
                <MenuItem danger icon={<UserX />} onSelect={() => setDeclining(team)}>
                  Decline team
                </MenuItem>
              ) : null}
              <MenuSeparator />
              <MenuItem danger icon={<Trash2 />} onSelect={() => setDeleting(team)}>
                Delete team
              </MenuItem>
            </MenuContent>
          </Menu>
        </div>
      </div>
      {team.incomplete && team.status === "PENDING_APPROVAL" ? (
        <p id={`team-approve-reason-${team.id}`} className="text-caption text-ink-muted">
          Can&apos;t be approved yet: this team needs at least {team.minSize} people.
        </p>
      ) : null}
      <ul aria-label={`Members of ${team.name}`} className="flex flex-col divide-y divide-line rounded-lg bg-subtle">
        {team.members.map((member) => (
          <li key={member.rsvpId} className="flex min-w-0 items-center gap-3 px-3 py-2">
            <Avatar name={member.name} size="sm" tone={member.checkedIn ? "success" : "neutral"} />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="flex min-w-0 items-center gap-1.5 text-sm font-semibold text-ink">
                <span className="truncate">{member.name}</span>
                {member.isLeader ? (
                  <span className="inline-flex shrink-0 items-center gap-1 text-caption font-semibold text-ink-secondary">
                    <Crown aria-hidden className="size-3.5" />
                    Leader
                  </span>
                ) : null}
              </span>
              <span className="truncate text-caption text-ink-muted">
                {member.email ?? ""}
                {member.checkedIn ? `${member.email ? " · " : ""}Checked in` : ""}
              </span>
            </span>
            <Menu>
              <MenuTrigger asChild>
                <IconButton size="sm" variant="quiet" label={`Actions for ${member.name}`} disabled={pending}>
                  <MoreHorizontal />
                </IconButton>
              </MenuTrigger>
              <MenuContent>
                <MenuItem icon={<ArrowRightLeft />} onSelect={() => setMoving({ member, team })}>
                  Move to another team
                </MenuItem>
                <MenuSeparator />
                <MenuItem danger icon={<UserMinus />} onSelect={() => setRemoving({ member, team })}>
                  Remove from event
                </MenuItem>
              </MenuContent>
            </Menu>
          </li>
        ))}
      </ul>
    </li>
  );
}
