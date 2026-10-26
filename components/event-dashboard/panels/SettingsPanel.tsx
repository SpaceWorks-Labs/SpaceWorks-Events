import { loadSettingsPanel } from "@/lib/views/components__event-dashboard__panels__SettingsPanel";
import { toEventClientDto } from "@/lib/eventDto";
import type { EventDashboardContext } from "@/lib/eventDashboard/context";
import { CollaboratorInvitePanel } from "@/components/event/CollaboratorInvitePanel";
import { EventManageMore } from "@/components/dashboard/EventManageMore";
import { JudgingSettingsCard } from "./JudgingPanelSetup";
import { TicketTypesManager } from "@/components/event-dashboard/settings/TicketTypesManager";
import { AddOnsManager } from "@/components/event-dashboard/settings/AddOnsManager";
import { PromoCodesManager, RefundPolicyControl, TransfersControl } from "@/components/event-dashboard/settings/PromoCodesManager";
import { TeamTicketModeControl } from "@/components/event-dashboard/settings/TeamTicketModeControl";
import { EntryFeeControl } from "@/components/event-dashboard/settings/EntryFeeControl";
import { TicketDesignCard } from "@/components/event-dashboard/settings/TicketDesignCard";
import { NoPermission } from "./shared";

export async function SettingsPanel({ ctx, judgingInUse = false }: { ctx: EventDashboardContext; judgingInUse?: boolean; }) {
  const { permissions, organisation, event, collaborators, pending, tickets, judgingCard, entryFee, ticketDesign } = await loadSettingsPanel({ ctx, judgingInUse });
  return (
    <div className="flex flex-col gap-5">
      {tickets ? (
        <TicketTypesManager
          organisationSlug={organisation.slug}
          target={{ eventId: event.id }}
          tickets={tickets.tickets}
          currency={tickets.currency}
          paidAllowed={tickets.paidAllowed}
          paidBlockedReason={tickets.paidBlockedReason}
          payee={tickets.payee}
        />
      ) : null}
      {tickets && event.registrationMode === "TEAM" && tickets.tickets.length > 0 ? (
        <TeamTicketModeControl organisationSlug={organisation.slug} eventId={event.id} mode={event.teamTicketMode} sold={tickets.sold} />
      ) : null}
      {ticketDesign ? <TicketDesignCard organisationSlug={organisation.slug} eventId={event.id} {...ticketDesign} /> : null}
      {entryFee ? <EntryFeeControl organisationSlug={organisation.slug} eventId={event.id} {...entryFee} /> : null}
      {tickets ? (
        <AddOnsManager organisationSlug={organisation.slug} target={{ eventId: event.id }} currency={tickets.currency} addOns={tickets.addOns} paidAllowed={tickets.paidAllowed} />
      ) : null}
      {tickets ? (
        <PromoCodesManager organisationSlug={organisation.slug} target={{ eventId: event.id }} currency={tickets.currency} promoCodes={tickets.promoCodes} tickets={tickets.tickets} />
      ) : null}
      {tickets && tickets.tickets.length > 0 ? (
        <TransfersControl organisationSlug={organisation.slug} target={{ eventId: event.id }} transfers={tickets.transfers} />
      ) : null}
      {tickets && tickets.tickets.some((ticket) => ticket.priceMinor > 0) ? (
        <RefundPolicyControl organisationSlug={organisation.slug} target={{ eventId: event.id }} policy={tickets.refundPolicy} sold={tickets.sold} />
      ) : null}
      {permissions.canManageCollaborators ? (
        <CollaboratorInvitePanel
          organisationSlug={organisation.slug}
          organisationName={organisation.name}
          eventId={event.id}
          now={ctx.now.toISOString()}
          collaborators={collaborators.map((c) => ({ id: c.id, name: c.user.name, email: c.user.email, permissions: c.permissions }))}
          pendingInvites={pending.map((invite) => ({ id: invite.id, email: invite.email, expiresAt: invite.expiresAt.toISOString(), permissions: invite.permissions }))}
        />
      ) : null}
      {judgingCard ? <JudgingSettingsCard scope={judgingCard.scope} settings={judgingCard.settings} now={ctx.now.toISOString()} /> : null}
      {/* Address, clone, embed and delete are organisation-admin actions on the server. */}
      {permissions.isAdmin ? (
        <EventManageMore organisationSlug={organisation.slug} event={toEventClientDto(event)} />
      ) : (
        <NoPermission>Only organisation owners and admins can change this event&apos;s address, clone it or delete it.</NoPermission>
      )}
    </div>
  );
}
