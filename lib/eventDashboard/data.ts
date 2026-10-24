import "server-only";

import { cache } from "react";
import type { Prisma, RegistrationFieldType, RegistrationMode } from "@prisma/client";
import type { AttendeeOrder } from "@/components/attendees/types";
import { prisma } from "@/lib/db";
import { countConfirmedForEvent } from "@/lib/rsvpCapacity";
import { effectiveOfflineRecord } from "@/lib/payments/offlineRecord";
import { toFieldDefinition, type FieldSettings } from "@/lib/registrationFields";

/*
 * Data loaders shared by several event-dashboard panels. Wrapped in React
 * `cache()` so the header and multiple panels can ask for the same numbers in
 * one request without repeating queries. Callers must check permissions
 * (see EventDashboardContext.permissions) before calling the guest-level ones.
 */

export type RsvpStatusCounts = { total: number; confirmed: number; waitlisted: number; pendingApproval: number; rejected: number; pendingPayment: number; checkedIn: number };

export const loadRsvpStatusCounts = cache(async (eventId: string): Promise<RsvpStatusCounts> => {
  const [groups, checkedIn] = await Promise.all([
    prisma.rSVP.groupBy({ by: ["status"], where: { eventId }, _count: { _all: true } }),
    prisma.rSVP.count({ where: { eventId, checkedInAt: { not: null } } }),
  ]);
  const of = (status: string) => groups.find((group) => group.status === status)?._count._all ?? 0;
  return {
    total: groups.reduce((sum, group) => sum + group._count._all, 0),
    confirmed: of("CONFIRMED"),
    waitlisted: of("WAITLISTED"),
    pendingApproval: of("PENDING_APPROVAL"),
    rejected: of("REJECTED"),
    pendingPayment: of("PENDING_PAYMENT"),
    checkedIn,
  };
});

/**
 * The number compared with `Event.capacity`: confirmed RSVPs on INDIVIDUAL
 * events, confirmed units (teams plus solo registrants) on TEAM events.
 */
export const loadCapacityUsed = cache(async (eventId: string, registrationMode: RegistrationMode): Promise<number> => countConfirmedForEvent(eventId, registrationMode));

export type RegistrationFieldRow = { id: string; key: string; label: string; type: RegistrationFieldType; required: boolean; sortOrder: number; options: string[]; helpText: string; placeholder: string; settings: FieldSettings };

export const loadRegistrationFields = cache(async (eventId: string): Promise<RegistrationFieldRow[]> => {
  const form = await prisma.eventRegistrationForm.findUnique({ where: { eventId }, include: { fields: { orderBy: { sortOrder: "asc" } } } });
  return (form?.fields ?? []).map((field) => ({ id: field.id, sortOrder: field.sortOrder, ...toFieldDefinition(field) }));
});

export const attendeeOrderSelect = {
  id: true, reference: true, status: true, totalMinor: true, currency: true, testMode: true,
  _count: { select: { rsvps: true } },
  payments: {
    where: { status: { in: ["PENDING", "PAID_ONLINE", "PAID_OFFLINE", "WAIVED"] } },
    select: {
      id: true, status: true, provider: true, amountMinor: true, offlineMethod: true, offlineReference: true,
      refunds: { select: { amountMinor: true, status: true } },
      amendments: { orderBy: { createdAt: "asc" }, select: { field: true, newValue: true } },
      disputes: { orderBy: { updatedAt: "desc" }, take: 1, select: { status: true, respondBy: true } },
    },
  },
} satisfies Prisma.OrderSelect;

/** One paid order's money, summed for the guest list. Duplicate captures (refunded automatically) count too. */
export function attendeeOrder(order: Prisma.OrderGetPayload<{ select: typeof attendeeOrderSelect; }>): AttendeeOrder {
  const collected = order.payments.filter((payment) => payment.status === "PAID_ONLINE" || payment.status === "PAID_OFFLINE");
  // Confirmed with an offline payment still owed: reserved to pay at the desk.
  const desk = order.status === "CONFIRMED" && order.payments.some((payment) => payment.status === "PENDING" && payment.provider === "OFFLINE");
  const dispute = collected.flatMap((payment) => payment.disputes)[0] ?? null;
  const sum = (values: bigint[]) => Number(values.reduce((total, value) => total + value, BigInt(0)));
  const refunds = collected.flatMap((payment) => payment.refunds);
  const offline = collected.find((payment) => payment.status === "PAID_OFFLINE");
  return {
    id: order.id,
    reference: order.reference,
    status: order.status,
    totalMinor: Number(order.totalMinor),
    currency: order.currency,
    testMode: order.testMode,
    tickets: order._count.rsvps,
    settlement: order.status !== "CONFIRMED" ? null : desk ? "desk" : offline ? "offline" : collected.length > 0 ? "online" : order.payments.some((payment) => payment.status === "WAIVED") ? "waived" : null,
    paidMinor: sum(collected.map((payment) => payment.amountMinor)),
    refundedMinor: sum(refunds.filter((refund) => refund.status === "SUCCEEDED").map((refund) => refund.amountMinor)),
    refundPendingMinor: sum(refunds.filter((refund) => refund.status === "PENDING").map((refund) => refund.amountMinor)),
    offlinePayment: offline ? { id: offline.id, ...effectiveOfflineRecord(offline) } : null,
    dispute: dispute ? { status: dispute.status, respondBy: dispute.respondBy?.toISOString() ?? null } : null,
  };
}
