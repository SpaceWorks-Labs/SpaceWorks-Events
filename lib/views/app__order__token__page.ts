import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { OrderStatus, PaymentRefundStatus, PaymentStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { refreshOrderFromProvider } from "@/lib/payments/checkout";
import { buyerCancellation } from "@/lib/payments/operations";
import { asRefundPolicy, describeRefundPolicy } from "@/lib/payments/refundPolicy";
import { formatMoney } from "@/lib/payments/money";
import { checkoutLineName } from "@/lib/payments/pricing";
import { ORDER_SUBJECT_SELECT, orderSubject } from "@/lib/payments/targets";
import { transferWindow } from "@/lib/payments/transfers";
import { toFieldDefinition } from "@/lib/registrationFields";
import { safeTimeZone } from "@/lib/timeZone";

type Props = {
  params: Promise<{ token: string; }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

function validToken(value: string | undefined) {
  const token = value?.trim() ?? "";
  return /^[a-z0-9]{20,40}$/.test(token) ? token : null;
}

export async function loadRouteMetadata(): Promise<Metadata> {
  return { title: "Your order", robots: { index: false, follow: false }, referrer: "no-referrer" };
}

/**
 * The buyer's order: lines, payment state and each ticket. The access token
 * is a bearer capability, like a ticket link; only what the buyer needs is
 * returned (no provider ids or links).
 */
export async function loadOrderView({ params, searchParams }: Props) {
  const token = validToken((await params).token);
  if (!token) notFound();
  const returning = (await searchParams)?.payment === "return";
  const found = await prisma.order.findUnique({ where: { accessToken: token }, select: { id: true, status: true } });
  if (!found) notFound();
  // Back from the provider's page: one status read so the order can confirm
  // before the webhook arrives (rate limited; the webhook stays the authority).
  if (returning && found.status === OrderStatus.PENDING) await refreshOrderFromProvider(found.id).catch(() => undefined);

  const order = await prisma.order.findUniqueOrThrow({
    where: { id: found.id },
    select: {
      reference: true, status: true, currency: true, subtotalMinor: true, discountMinor: true, totalMinor: true, testMode: true, holdExpiresAt: true, buyerName: true, refundPolicy: true,
      lines: { select: { id: true, description: true, quantity: true, totalMinor: true }, orderBy: { createdAt: "asc" } },
      payments: { where: { status: { in: [PaymentStatus.PENDING, PaymentStatus.PAID_ONLINE, PaymentStatus.PAID_OFFLINE] } }, select: { status: true, refunds: { where: { automatic: false, status: { not: PaymentRefundStatus.FAILED } }, select: { amountMinor: true, status: true } } }, orderBy: { createdAt: "desc" } },
      ...ORDER_SUBJECT_SELECT,
      eventId: true,
      eventSeriesId: true,
      teamName: true,
      event: { select: { ...ORDER_SUBJECT_SELECT.event.select, teamTicketMode: true } },
      rsvps: {
        orderBy: { createdAt: "asc" },
        select: {
          id: true, status: true, checkInToken: true, guestName: true, guestEmail: true, checkedInAt: true, attendeeKey: true,
          eventInstance: { select: { startDateTime: true } },
          user: { select: { name: true, email: true } },
          ticketType: { select: { name: true } },
          answers: { select: { fieldId: true, valueText: true, valueBool: true, valueNumber: true, valueDate: true } },
        },
      },
    },
  });
  // Registration questions belong to events; series ask none.
  const formFields = order.eventId ? (await prisma.eventRegistrationForm.findUnique({ where: { eventId: order.eventId }, select: { fields: { orderBy: { sortOrder: "asc" } } } }))?.fields ?? [] : [];
  const subject = orderSubject(order);
  // Transfers, where the organiser allows them, until their cut-off before each ticket's start.
  const transferSettings = order.eventId
    ? await prisma.event.findUnique({ where: { id: order.eventId }, select: { allowTransfers: true, transferCutoffHours: true } })
    : order.eventSeriesId ? await prisma.eventSeries.findUnique({ where: { id: order.eventSeriesId }, select: { allowTransfers: true, transferCutoffHours: true } }) : null;
  const transferUntil = (rsvp: { eventInstance: { startDateTime: Date; } | null; }) => order.status === OrderStatus.CONFIRMED
    ? transferWindow(transferSettings, rsvp.eventInstance?.startDateTime ?? subject?.start ?? null)
    : null;
  // A pass seats each person on every date: show each person once (their
  // first date's ticket, whose page lists the rest).
  const people = subject?.pass ? order.rsvps.filter((rsvp, index) => order.rsvps.findIndex((other) => other.attendeeKey === rsvp.attendeeKey) === index) : order.rsvps;
  /** Saved answers as the form's initial values, keyed by question. */
  const initialAnswers = (answers: (typeof order.rsvps)[number]["answers"]) => {
    const values: Record<string, unknown> = {};
    for (const field of formFields) {
      const mine = answers.filter((answer) => answer.fieldId === field.id);
      if (field.type === "MULTI_SELECT") values[field.key] = mine.map((answer) => answer.valueText).filter(Boolean);
      else if (field.type === "CHECKBOX") values[field.key] = mine[0]?.valueBool ?? false;
      else if (field.type === "NUMBER") values[field.key] = mine[0]?.valueNumber ?? "";
      else if (field.type === "DATE") values[field.key] = mine[0]?.valueDate ? mine[0].valueDate.toISOString().slice(0, 10) : "";
      else values[field.key] = mine[0]?.valueText ?? "";
    }
    return values;
  };
  const now = new Date();
  const holdActive = order.status === OrderStatus.PENDING && Boolean(order.holdExpiresAt && order.holdExpiresAt > now);
  const refunds = order.payments.flatMap((payment) => payment.refunds);
  const refundedMinor = refunds.reduce((sum, refund) => sum + refund.amountMinor, BigInt(0));
  const cancellation = order.status === OrderStatus.CONFIRMED && order.totalMinor > BigInt(0) ? await buyerCancellation(found.id, now) : null;
  const policy = asRefundPolicy(order.refundPolicy);
  return {
    token,
    returning,
    reference: order.reference,
    status: order.status,
    testMode: order.testMode,
    holdActive,
    holdExpiresAt: order.holdExpiresAt?.toISOString() ?? null,
    canPay: holdActive && order.payments.some((payment) => payment.status === PaymentStatus.PENDING),
    /** Proof of payment once money has been collected, refunded or not. */
    receiptHref: order.payments.some((payment) => payment.status !== PaymentStatus.PENDING) ? `/api/orders/${token}/receipt` : null,
    total: formatMoney(order.totalMinor, order.currency),
    subtotal: formatMoney(order.subtotalMinor, order.currency),
    discount: order.discountMinor > BigInt(0) ? formatMoney(order.discountMinor, order.currency) : null,
    refunded: refundedMinor > BigInt(0) ? { amount: formatMoney(refundedMinor, order.currency), pending: refunds.some((refund) => refund.status === PaymentRefundStatus.PENDING) } : null,
    /** The policy this order was bought under, and what cancelling now returns. */
    refundPolicy: order.totalMinor > BigInt(0) && policy ? `${describeRefundPolicy(policy)}${policy.text ? ` ${policy.text}` : ""}` : null,
    cancellation: cancellation ? {
      refund: cancellation.refundMinor > BigInt(0) ? formatMoney(cancellation.refundMinor, order.currency) : null,
      // A PER_TEAM leader's ticket covers the team: cancelling it cancels everyone in it (docs/TEAMS.md).
      team: order.teamName != null && order.event?.teamTicketMode === "PER_TEAM" ? order.teamName : null,
    } : null,
    free: order.totalMinor === BigInt(0),
    lines: order.lines.map((line) => ({ id: line.id, label: checkoutLineName(line), amount: formatMoney(line.totalMinor, order.currency) })),
    event: subject
      ? { title: subject.title, href: subject.path, organisation: subject.organisation.name, start: subject.start?.toISOString() ?? null, timeZone: safeTimeZone(subject.timeZone) }
      : null,
    pass: subject?.pass ?? false,
    fields: formFields.map(toFieldDefinition),
    tickets: people.map((rsvp, index) => ({
      id: rsvp.id,
      label: `${rsvp.ticketType?.name ?? "Ticket"} ${index + 1}`,
      name: rsvp.user?.name ?? rsvp.guestName ?? "",
      email: rsvp.user?.email ?? rsvp.guestEmail ?? "",
      account: rsvp.user != null,
      needsDetails: !(rsvp.user?.email || rsvp.guestEmail),
      status: rsvp.status,
      checkedIn: rsvp.checkedInAt != null,
      ticketHref: rsvp.status === "CONFIRMED" ? `/ticket/${rsvp.checkInToken}` : null,
      /** Until when this ticket can be given to someone else, if at all. */
      transferUntil: rsvp.status === "CONFIRMED" && !rsvp.checkedInAt ? transferUntil(rsvp)?.toISOString() ?? null : null,
      initialAnswers: initialAnswers(rsvp.answers),
    })),
  };
}
