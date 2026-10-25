"use client";

import { Check, Crown, MoreHorizontal, UserMinus, UserPlus } from "lucide-react";
import { Button, IconButton } from "@/components/ui/button";
import { Avatar, Card, CardHeader, Chip } from "@/components/ui/display";
import { Field, Input } from "@/components/ui/field";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import type { TeamManagerMember, TeamManagerProps } from "./types";
import type { TeamManagerState } from "./useTeamManager";

/** The member list with leader actions, and the form to add a member directly. */
export function MembersCard({ members, event, m }: { members: TeamManagerMember[]; event: TeamManagerProps["event"]; m: TeamManagerState }) {
  const { rejected, setConfirm, canAdd, submitMember, memberErrors, memberName, setMemberName, memberEmail, setMemberEmail, busyId, full } = m;
  return (
    <Card as="section" aria-labelledby="team-members">
      <CardHeader title={<span id="team-members">Members</span>} description="Members see each other's names on their tickets." />
      <ul className="flex flex-col divide-y divide-line">
        {members.map((member) => (
          <li key={member.rsvpId} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
            <Avatar name={member.name} size="sm" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-label text-ink">{member.name}</p>
              <div className="mt-0.5 flex flex-wrap gap-1.5">
                {member.isLeader ? <Chip tone="ink" size="sm" icon={<Crown />}>Leader</Chip> : null}
                {member.checkedIn ? <Chip tone="success" size="sm" icon={<Check />}>Checked in</Chip> : null}
              </div>
            </div>
            {member.isLeader ? null : (
              <Menu>
                <MenuTrigger asChild>
                  <IconButton label={`Actions for ${member.name}`} size="sm">
                    <MoreHorizontal />
                  </IconButton>
                </MenuTrigger>
                <MenuContent>
                  {!rejected ? (
                    <MenuItem icon={<Crown />} onSelect={() => setConfirm({ kind: "transfer", member })}>Make leader…</MenuItem>
                  ) : null}
                  <MenuItem danger icon={<UserMinus />} disabled={member.checkedIn} onSelect={() => setConfirm({ kind: "remove", member })}>
                    Remove from team…
                  </MenuItem>
                </MenuContent>
              </Menu>
            )}
          </li>
        ))}
      </ul>

      <div className="mt-5 border-t border-line pt-5">
        <h3 className="text-label text-ink">Add a member</h3>
        {canAdd ? (
          <form onSubmit={submitMember} className="mt-3 flex flex-col gap-3.5" noValidate>
            <p className="text-caption text-ink-muted">We&apos;ll email them their own ticket. They don&apos;t need to fill in the registration form.</p>
            <div className="grid gap-3.5 sm:grid-cols-2">
              <Field label="Name" error={memberErrors.name?.[0]}>
                <Input value={memberName} onChange={(e) => setMemberName(e.target.value)} autoComplete="off" maxLength={200} required />
              </Field>
              <Field label="Email" error={memberErrors.email?.[0]}>
                <Input type="email" value={memberEmail} onChange={(e) => setMemberEmail(e.target.value)} autoComplete="off" maxLength={320} required />
              </Field>
            </div>
            <div>
              <Button type="submit" variant="primary" loading={busyId === "add-member"} loadingLabel="Adding…" startIcon={<UserPlus />}>
                Add member
              </Button>
            </div>
          </form>
        ) : (
          <p className="mt-1 text-body-ui text-ink-muted">
            {rejected
              ? "This team can't take new members."
              : full
                ? "Your team is full."
                : !event.registrationOpen
                  ? "Registration for this event is closed, so no one else can be added."
                  : "This event is invite-only. Share your team's join link instead; each person signs in with their invited account to join."}
          </p>
        )}
      </div>
    </Card>
  );
}
