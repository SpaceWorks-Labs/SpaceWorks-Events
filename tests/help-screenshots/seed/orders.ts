import { OfflinePaymentMethod, OrderLineKind, OrderStatus, PaymentProvider, PaymentRefundStatus, PaymentStatus, RefundRequestStatus, RsvpStatus } from "@prisma/client";
import { CURRENCY, DAY, MINUTE, emailFor, inr, type Db } from "./common";
import type { People } from "./people";
import type { PaidEvent } from "./payments";

type Line = { kind?: "TICKET" | "ADD_ON"; type: { id: string; name: string }; quantity: number; unit: bigint; discount?: bigint; seats?: number };
type Attendee = { name?: string; userId?: string; checkedIn?: boolean };
type Settlement =
  | { kind: "online"; summary: string; methodType: string }
  | { kind: "cash"; reference: string }
  | { kind: "desk" }
  | { kind: "waived" }
  | { kind: "free" };

type OrderSpec = {
  reference: string;
  buyer: string;
  buyerUserId?: string;
  daysAgo: number;
  lines: Line[];
  attendees: Attendee[];
  settlement: Settlement;
  promo?: boolean;
  refund?: { amount: bigint; reason: string; daysAgo: number; cancel?: boolean };
  refundRequest?: string;
};

/** Ticket sales for the paid conference: online, cash, at the desk, complimentary, refunded and partly refunded. */
export async function seedOrders(prisma: Db, people: People, paid: PaidEvent, now: number) {
  const { org, owner, buyer } = people;
  const { summit, types, addOns, earlyBird } = paid;
  const t = (type: { id: string; name: string }, quantity: number, unit: bigint, discount?: bigint, seats?: number): Line => ({ type, quantity, unit, discount, seats });
  const extra = (addOn: { id: string; name: string }, quantity: number, unit: bigint): Line => ({ kind: "ADD_ON", type: addOn, quantity, unit });
  const upi = { kind: "online", methodType: "upi", summary: "UPI" } as const;
  const card = { kind: "online", methodType: "card", summary: "Visa •••• 4242" } as const;

  const specs: OrderSpec[] = [
    {
      reference: "RVWS-7K2Q", buyer: "Olu Adebayo", buyerUserId: buyer.id, daysAgo: 9, promo: true, settlement: card,
      lines: [t(types.standard, 2, inr(999), inr(399.6)), extra(addOns.tshirt, 1, inr(600))],
      attendees: [{ name: "Olu Adebayo", userId: buyer.id }, {}],
    },
    { reference: "RVWS-M3PL", buyer: "Meera Pillai", daysAgo: 12, settlement: upi, lines: [t(types.standard, 1, inr(999))], attendees: [{ name: "Meera Pillai" }] },
    {
      reference: "RVWS-R4HN", buyer: "Rohan Mehta", daysAgo: 7, settlement: { kind: "online", methodType: "netbanking", summary: "Net banking" },
      lines: [t(types.group, 1, inr(3200), undefined, 4)], attendees: [{ name: "Rohan Mehta" }, { name: "Asha Kurian" }, { name: "Vikram Nair" }, {}],
      refund: { amount: inr(800), reason: "One teammate can no longer come.", daysAgo: 2 },
    },
    {
      reference: "RVWS-S8RA", buyer: "Sara Ahmed", daysAgo: 10, settlement: card, lines: [t(types.standard, 1, inr(999))], attendees: [],
      refund: { amount: inr(999), reason: "Bought twice by mistake.", daysAgo: 6, cancel: true },
    },
    {
      reference: "RVWS-T9VG", buyer: "Tom Varghese", daysAgo: 3, settlement: { kind: "cash", reference: "Receipt 0142" },
      lines: [t(types.standard, 1, inr(999)), extra(addOns.social, 1, inr(750))], attendees: [{ name: "Tom Varghese" }],
    },
    { reference: "RVWS-A2NJ", buyer: "Anu Joseph", daysAgo: 2, settlement: { kind: "desk" }, lines: [t(types.standard, 1, inr(999))], attendees: [{ name: "Anu Joseph" }] },
    {
      reference: "RVWS-K5RR", buyer: "Kiran Rao", daysAgo: 5, settlement: upi, lines: [t(types.supporter, 1, inr(1500))], attendees: [{ name: "Kiran Rao" }],
      refundRequest: "My company will now pay for my place, so I'd like my supporter ticket refunded, please.",
    },
    { reference: "RVWS-L6MN", buyer: "Leela Menon", daysAgo: 4, settlement: { kind: "waived" }, lines: [t(types.standard, 1, inr(999))], attendees: [{ name: "Leela Menon" }] },
    { reference: "RVWS-J7DS", buyer: "Joel D'Souza", daysAgo: 8, settlement: { kind: "free" }, lines: [t(types.community, 1, BigInt(0))], attendees: [{ name: "Joel D'Souza" }] },
    { reference: "RVWS-F8TH", buyer: "Fathima Rahman", daysAgo: 13, settlement: upi, promo: true, lines: [t(types.standard, 1, inr(999), inr(199.8))], attendees: [{ name: "Fathima Rahman" }] },
    { reference: "RVWS-N2KR", buyer: "Nikhil Kumar", daysAgo: 11, settlement: card, lines: [t(types.standard, 1, inr(999)), extra(addOns.tshirt, 1, inr(600))], attendees: [{ name: "Nikhil Kumar" }] },
    { reference: "RVWS-D3VY", buyer: "Divya Iyer", daysAgo: 6, settlement: upi, lines: [t(types.supporter, 1, inr(2500))], attendees: [{ name: "Divya Iyer" }] },
    { reference: "RVWS-G4BR", buyer: "Gautham Babu", daysAgo: 1, settlement: upi, lines: [t(types.standard, 2, inr(999))], attendees: [{ name: "Gautham Babu" }, { name: "Reshma Babu" }] },
    { reference: "RVWS-H5PS", buyer: "Hari Prasad", daysAgo: 0, settlement: card, lines: [t(types.standard, 1, inr(999)), extra(addOns.social, 2, inr(750))], attendees: [{ name: "Hari Prasad" }] },
  ];

  const tokens: Record<string, { accessToken: string; ticketTokens: string[]; rsvpIds: string[] }> = {};
  for (const spec of specs) {
    const paidAt = new Date(now - spec.daysAgo * DAY - 3 * 60 * MINUTE);
    const subtotal = spec.lines.reduce((sum, line) => sum + line.unit * BigInt(line.quantity), BigInt(0));
    const discount = spec.lines.reduce((sum, line) => sum + (line.discount ?? BigInt(0)), BigInt(0));
    const total = subtotal - discount;
    const online = spec.settlement.kind === "online";
    const cancelled = spec.refund?.cancel === true;
    const buyerEmail = spec.buyerUserId ? people.buyer.email! : emailFor(spec.buyer);
    const order = await prisma.order.create({
      data: {
        organisationId: org.id, eventId: summit.id, reference: spec.reference, buyerUserId: spec.buyerUserId ?? null, buyerEmail, buyerName: spec.buyer,
        status: cancelled ? OrderStatus.CANCELLED : OrderStatus.CONFIRMED, currency: CURRENCY, subtotalMinor: subtotal, discountMinor: discount, totalMinor: total,
        testMode: online, promoCodeId: spec.promo ? earlyBird.id : null, refundPolicy: { kind: "NONE", hours: null, percent: null, text: summit.refundPolicyText },
        createdAt: new Date(paidAt.getTime() - 4 * MINUTE),
        lines: {
          create: spec.lines.map((line) => ({
            kind: line.kind === "ADD_ON" ? OrderLineKind.ADD_ON : OrderLineKind.TICKET,
            ticketTypeId: line.kind === "ADD_ON" ? null : line.type.id, addOnId: line.kind === "ADD_ON" ? line.type.id : null,
            description: line.type.name, quantity: line.quantity, unitMinor: line.unit, discountMinor: line.discount ?? BigInt(0),
            taxableMinor: line.unit * BigInt(line.quantity) - (line.discount ?? BigInt(0)), totalMinor: line.unit * BigInt(line.quantity) - (line.discount ?? BigInt(0)),
          })),
        },
      },
    });
    const ticketLine = spec.lines.find((line) => line.kind !== "ADD_ON")!;
    const ticketTokens: string[] = [];
    const rsvpIds: string[] = [];
    for (const [index, attendee] of spec.attendees.entries()) {
      const email = attendee.userId ? null : attendee.name ? emailFor(attendee.name) : null;
      const rsvp = await prisma.rSVP.create({
        data: {
          eventId: summit.id, orderId: order.id, ticketTypeId: ticketLine.type.id, status: RsvpStatus.CONFIRMED, createdAt: paidAt,
          userId: attendee.userId ?? null, guestEmail: email, guestName: attendee.userId ? null : attendee.name ?? null,
          attendeeKey: attendee.userId ? `user:${attendee.userId}` : email ? `guest:${email}` : `order:${order.id}:${index}`,
        },
      });
      ticketTokens.push(rsvp.checkInToken);
      rsvpIds.push(rsvp.id);
    }
    tokens[spec.reference] = { accessToken: order.accessToken, ticketTokens, rsvpIds };

    if (spec.settlement.kind === "free") continue;
    const settlement = spec.settlement;
    const payment = await prisma.payment.create({
      data: {
        organisationId: org.id, orderId: order.id, amountMinor: total, currency: CURRENCY, testMode: online, description: summit.title,
        provider: online ? PaymentProvider.RAZORPAY : PaymentProvider.OFFLINE,
        status: settlement.kind === "online" ? PaymentStatus.PAID_ONLINE : settlement.kind === "cash" ? PaymentStatus.PAID_OFFLINE : settlement.kind === "waived" ? PaymentStatus.WAIVED : PaymentStatus.PENDING,
        externalPaymentId: online ? `pay_Example${spec.reference.replace("-", "")}` : null,
        paidAt: settlement.kind === "desk" ? null : paidAt,
        methodType: settlement.kind === "online" ? settlement.methodType : null,
        methodSummary: settlement.kind === "online" ? settlement.summary : null,
        offlineMethod: settlement.kind === "cash" ? OfflinePaymentMethod.CASH : null,
        offlineReference: settlement.kind === "cash" ? settlement.reference : null,
        settledByUserId: settlement.kind === "cash" || settlement.kind === "waived" ? owner.id : null,
        createdAt: paidAt,
      },
    });
    if (spec.refund) {
      const at = new Date(now - spec.refund.daysAgo * DAY);
      await prisma.paymentRefund.create({
        data: {
          paymentId: payment.id, amountMinor: spec.refund.amount, status: PaymentRefundStatus.SUCCEEDED, externalRefundId: `rfnd_Example${spec.reference.replace("-", "")}`,
          reason: spec.refund.reason, createdByUserId: owner.id, submittedAt: at, settledAt: at, createdAt: at,
        },
      });
    }
    if (spec.refundRequest) {
      await prisma.refundRequest.create({
        data: { organisationId: org.id, orderId: order.id, status: RefundRequestStatus.OPEN, reason: spec.refundRequest, createdAt: new Date(now - DAY) },
      });
    }
  }
  return { orderToken: tokens["RVWS-7K2Q"]!.accessToken, claimTicketToken: tokens["RVWS-M3PL"]!.ticketTokens[0]!, claimRsvpId: tokens["RVWS-M3PL"]!.rsvpIds[0]! };
}
