import { loadGuestsPanel } from "@/lib/views/components__event-dashboard__panels__GuestsPanel";
import type { EventDashboardContext } from "@/lib/eventDashboard/context";
import { EventInvitePanel } from "@/components/invites/EventInvitePanel";
import { SubTabs, type SubTab } from "../SubTabs";
import { GuestsPeople } from "./GuestsPeople";
import { GuestsTeams } from "./GuestsTeams";
import { NoPermission } from "./shared";

export async function GuestsPanel({ ctx }: { ctx: EventDashboardContext; }) {
  const { permissions, organisation, event, attendees, fields, invites, ticketTypes, teamMode, teamsPage, moveTargets } = await loadGuestsPanel({ ctx });
  const teamsTab: SubTab[] = teamMode
    ? [
        {
          value: "teams",
          label: "Teams",
          count: teamsPage ? teamsPage.counts.all : undefined,
          content: teamsPage ? (
            <GuestsTeams organisationSlug={organisation.slug} eventId={event.id} initialPage={teamsPage} moveTargets={moveTargets} approvalRequired={event.privacyType === "APPROVAL_REQUIRED"} />
          ) : (
            <NoPermission>You do not have permission to view or manage attendee registrations.</NoPermission>
          ),
        },
      ]
    : [];
  return (
    <SubTabs
      label="Guests sections"
      items={[
        {
          value: "people",
          label: "People",
          content: permissions.canManageRegistrations ? (
            <GuestsPeople organisationSlug={organisation.slug} target={{ kind: "event", eventId: event.id, eventTitle: event.title }} timeZone={event.timezone} now={ctx.now.toISOString()} attendees={attendees.attendees} truncated={attendees.truncated} registrationFields={fields} ticketTypes={ticketTypes} canUndoCheckIn={permissions.canCheckIn} teamMode={teamMode} teams={moveTargets} />
          ) : (
            <NoPermission>You do not have permission to view or manage attendee registrations.</NoPermission>
          ),
        },
        ...teamsTab,
        {
          value: "invites",
          label: "Invites",
          count: permissions.canManageInvitations ? invites.length : undefined,
          content: permissions.canManageInvitations ? (
            <EventInvitePanel organisationSlug={organisation.slug} eventId={event.id} eventHasEnded={event.endDateTime <= ctx.now} invites={invites} timeZone={event.timezone} now={ctx.now.toISOString()} />
          ) : (
            <NoPermission>You do not have permission to manage invitations for this event.</NoPermission>
          ),
        },
      ]}
    />
  );
}
