import { prisma } from "@/lib/db";
import type { EventDashboardContext } from "@/lib/eventDashboard/context";
import { loadTicketSettings } from "@/lib/payments/ticketSettings";
import { loadJudgingSettingsCard } from "@/lib/eventDashboard/judging";
import { minorToDecimalString } from "@/lib/payments/money";
import { loadEventTicketDesigns } from "@/lib/ticketDesign/access";
import { STARTER_DESIGNS } from "@/lib/ticketDesign/presets";
import { admissionEnableState } from "@/lib/admission/settings";

/** Ticket types are an organisation owner/admin concern, like the actions that change them. */
async function loadTickets(ctx: EventDashboardContext) {
  if (!ctx.permissions.canEditTickets) return null;
  const policy = await prisma.event.findUniqueOrThrow({ where: { id: ctx.event.id }, select: { refundPolicyKind: true, refundPolicyHours: true, refundPolicyPercent: true, refundPolicyText: true, allowTransfers: true, transferCutoffHours: true } });
  return loadTicketSettings({ owner: { eventId: ctx.event.id }, organisation: ctx.organisation, currency: ctx.event.currency, refundPolicy: policy, transfers: policy, now: ctx.now });
}

/**
 * `judgingInUse`: whether the dashboard shows the Judging tab. While it does
 * not, owners and admins turn hackathon submissions on from Settings
 * (docs/HACKATHON.md); once on, the settings move to the Judging tab.
 */
export async function loadSettingsPanel({ ctx, judgingInUse = false }: { ctx: EventDashboardContext; judgingInUse?: boolean; }) {
  ctx = await loadEventDashboard(ctx.organisation.slug, ctx.event.id);
  const { event, permissions, organisation } = ctx;
  const judgingCard = !judgingInUse && permissions.canManageJudging ? await loadJudgingSettingsCard(ctx) : null;
  const [collaborators, pending] = permissions.canManageCollaborators
    ? await Promise.all([
      prisma.eventCollaborator.findMany({ where: { eventId: event.id }, include: { user: { select: { name: true, email: true } } }, orderBy: { createdAt: "asc" } }),
      prisma.eventCollaboratorInvite.findMany({ where: { eventId: event.id, usedAt: null, expiresAt: { gt: ctx.now } }, select: { id: true, email: true, expiresAt: true, permissions: true }, orderBy: { createdAt: "desc" } }),
    ])
    : [[], []];
  const tickets = await loadTickets(ctx);
  // The hackathon entry fee sits with the other prices (docs/HACKATHON.md).
  const entryFee = tickets && event.submissionsEnabled
    ? { currency: tickets.currency, fee: event.submissionFeeMinor ? minorToDecimalString(event.submissionFeeMinor, tickets.currency) : "", refundOnDisqualify: event.submissionFeeRefundOnDisqualify, paidBlockedReason: tickets.paidBlockedReason }
    : null;
  // Ticket design: the same people as ticket prices (EDIT_DETAILS), on every event.
  const ticketDesign = tickets ? { ...(await loadEventTicketDesigns(event.id, organisation.id)), starters: STARTER_DESIGNS.map((starter) => ({ key: starter.key, label: starter.label })) } : null;
  // Applications (docs/ADMISSION.md): owners and admins turn them on here; then they have their own tab.
  const applicationsCard = permissions.isAdmin && !event.admissionEnabled ? await admissionEnableState(event.id) : null;
  return { permissions, organisation, event, collaborators, pending, tickets, judgingCard, entryFee, ticketDesign, applicationsCard };
}

import { loadEventDashboard } from "@/lib/eventDashboard/context";
