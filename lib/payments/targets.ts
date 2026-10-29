import "server-only";

import { EventPrivacyType, EventStatus, OrderStatus, TicketTypeKind, type Prisma } from "@prisma/client";
import { titleWith } from "@/lib/noticeText";
import { isRegistrationClosed } from "@/lib/registrationCutoff";
import { seatTakingWhere } from "./holds";
import type { RefundPolicySnapshot } from "./refundPolicy";
import { sqlUtcTimestamp } from "@/lib/sqlTimestamp";

/**
 * What an order is for: an event, one date of a series, or a pass that holds
 * a seat on every remaining date of a series.
 */
export type OrderTarget = { eventId: string; } | { eventInstanceId: string; } | { passSeriesId: string; };

/** Where a registration sits: an event or one date. */
export type SeatTarget = { eventId: string; } | { eventInstanceId: string; };

export type Slot = { target: SeatTarget; capacity: number | null; label: string; };

/** Everything an order needs from its event or series, read under its locks. */
export type Sellable = {
  organisationId: string;
  title: string;
  privacyType: EventPrivacyType;
  /** One-off events taking applications (docs/ADMISSION.md). */
  admission?: boolean;
  currency: string | null;
  refundPolicy: RefundPolicySnapshot;
  open: boolean;
  /** Columns that tie the order to its event, or its series and date. */
  orderColumns: { eventId: string; } | { eventSeriesId: string; eventInstanceId: string | null; };
  /** Ticket types and promo codes are looked up by this. */
  owner: { eventId: string; } | { eventSeriesId: string; };
  typeKind: TicketTypeKind;
  /** The event, the date, or every remaining date of a pass, in date order. */
  slots: Slot[];
};

const DATE_LABEL: Intl.DateTimeFormatOptions = { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" };

function dateLabel(date: Date, timeZone: string) {
  try {
    return date.toLocaleString("en-GB", { ...DATE_LABEL, timeZone });
  } catch {
    return date.toLocaleString("en-GB", { ...DATE_LABEL, timeZone: "UTC" });
  }
}

/**
 * The organisation fence (docs/PAYMENTS.md), the first lock of every path
 * that creates an order or a payment: a key-share lock on the Organisation
 * row. It never blocks other payment paths, but organisation deletion takes
 * the row FOR UPDATE, so the two run one after the other instead of the
 * deletion's cascade meeting an order still being written. False when the
 * organisation is gone (deleted while this waited).
 */
export async function fenceOrganisation(tx: Prisma.TransactionClient, organisationId: string) {
  const rows = await tx.$queryRaw<Array<{ id: string; }>>`SELECT "id" FROM "Organisation" WHERE "id" = ${organisationId} FOR KEY SHARE`;
  return rows.length === 1;
}

/** The organisation owning an event or series, read before any lock so its fence comes first. */
async function fenceOwner(tx: Prisma.TransactionClient, owner: { eventId: string; } | { eventSeriesId: string; }) {
  const row = "eventId" in owner
    ? await tx.event.findUnique({ where: { id: owner.eventId }, select: { organisationId: true } })
    : await tx.eventSeries.findUnique({ where: { id: owner.eventSeriesId }, select: { organisationId: true } });
  return row != null && fenceOrganisation(tx, row.organisationId);
}

/**
 * Lock what the order sells, always in the same order so concurrent orders
 * never deadlock: the organisation fence; then the event row, or the series
 * row and its dates by id.
 */
export async function lockSellable(tx: Prisma.TransactionClient, target: OrderTarget, now: Date): Promise<Sellable | null> {
  if ("eventId" in target) {
    if (!(await fenceOwner(tx, { eventId: target.eventId }))) return null;
    await tx.$queryRaw`SELECT "id" FROM "Event" WHERE "id" = ${target.eventId} FOR UPDATE`;
    const event = await tx.event.findUnique({
      where: { id: target.eventId },
      select: {
        id: true, organisationId: true, title: true, capacity: true, privacyType: true, status: true, currency: true, admissionEnabled: true,
        startDateTime: true, endDateTime: true, registrationClosesAt: true, registrationLeadMinutes: true, page: { select: { isPublished: true } },
        refundPolicyKind: true, refundPolicyHours: true, refundPolicyPercent: true, refundPolicyText: true,
      },
    });
    if (!event) return null;
    return {
      organisationId: event.organisationId,
      title: event.title,
      privacyType: event.privacyType,
      admission: event.admissionEnabled,
      currency: event.currency,
      refundPolicy: { kind: event.refundPolicyKind, hours: event.refundPolicyHours, percent: event.refundPolicyPercent, text: event.refundPolicyText },
      open: event.status === EventStatus.PUBLISHED && event.page?.isPublished === true && event.endDateTime > now && !isRegistrationClosed(event),
      orderColumns: { eventId: event.id },
      owner: { eventId: event.id },
      typeKind: TicketTypeKind.SINGLE,
      slots: [{ target: { eventId: event.id }, capacity: event.capacity, label: event.title }],
    };
  }

  const seriesId = "passSeriesId" in target
    ? target.passSeriesId
    : (await tx.eventInstance.findUnique({ where: { id: target.eventInstanceId }, select: { eventSeriesId: true } }))?.eventSeriesId;
  if (!seriesId || !(await fenceOwner(tx, { eventSeriesId: seriesId }))) return null;
  await lockSeriesDates(tx, seriesId, "eventInstanceId" in target ? [target.eventInstanceId] : null, now);
  const series = await tx.eventSeries.findUnique({
    where: { id: seriesId },
    select: {
      id: true, organisationId: true, title: true, capacity: true, privacyType: true, status: true, currency: true, timezone: true,
      refundPolicyKind: true, refundPolicyHours: true, refundPolicyPercent: true, refundPolicyText: true,
    },
  });
  if (!series) return null;
  const dates = await tx.eventInstance.findMany({
    where: "eventInstanceId" in target
      ? { id: target.eventInstanceId, eventSeriesId: series.id }
      : { eventSeriesId: series.id, cancelledAt: null, endDateTime: { gt: now } },
    orderBy: { startDateTime: "asc" },
    select: { id: true, startDateTime: true, endDateTime: true, capacity: true, cancelledAt: true },
  });
  if (dates.length === 0 && "eventInstanceId" in target) return null;
  const live = dates.every((date) => date.cancelledAt == null && date.endDateTime > now);
  return {
    organisationId: series.organisationId,
    title: series.title,
    privacyType: series.privacyType,
    currency: series.currency,
    refundPolicy: { kind: series.refundPolicyKind, hours: series.refundPolicyHours, percent: series.refundPolicyPercent, text: series.refundPolicyText },
    open: series.status === EventStatus.PUBLISHED && dates.length > 0 && live,
    orderColumns: { eventSeriesId: series.id, eventInstanceId: "eventInstanceId" in target ? target.eventInstanceId : null },
    owner: { eventSeriesId: series.id },
    typeKind: "passSeriesId" in target ? TicketTypeKind.PASS : TicketTypeKind.SINGLE,
    slots: dates.map((date) => ({
      target: { eventInstanceId: date.id },
      capacity: date.capacity ?? series.capacity,
      label: titleWith(series.title, dateLabel(date.startDateTime, series.timezone)),
    })),
  };
}

/**
 * The series row, then its dates by id. With `ids`, only those dates; without,
 * every date that hasn't ended (what a pass covers).
 */
export async function lockSeriesDates(tx: Prisma.TransactionClient, seriesId: string, ids: string[] | null, now: Date) {
  await tx.$queryRaw`SELECT "id" FROM "EventSeries" WHERE "id" = ${seriesId} FOR UPDATE`;
  if (ids) {
    if (ids.length > 0) await tx.$queryRaw`SELECT "id" FROM "EventInstance" WHERE "id" = ANY(${ids}) AND "eventSeriesId" = ${seriesId} ORDER BY "id" FOR UPDATE`;
  } else {
    await tx.$queryRaw`SELECT "id" FROM "EventInstance" WHERE "eventSeriesId" = ${seriesId} AND "endDateTime" > ${sqlUtcTimestamp(now)} ORDER BY "id" FOR UPDATE`;
  }
}

/** Lock an existing order's event, or its series and the dates it has seats on. */
export async function lockOrderTargets(tx: Prisma.TransactionClient, order: { id: string; eventId: string | null; eventSeriesId: string | null; }, now = new Date()) {
  if (order.eventId) {
    await tx.$queryRaw`SELECT "id" FROM "Event" WHERE "id" = ${order.eventId} FOR UPDATE`;
  } else if (order.eventSeriesId) {
    const dates = await tx.rSVP.findMany({ where: { orderId: order.id, eventInstanceId: { not: null } }, select: { eventInstanceId: true }, distinct: ["eventInstanceId"] });
    await lockSeriesDates(tx, order.eventSeriesId, dates.map((date) => date.eventInstanceId!), now);
  }
}

/** Passes of a ticket type that hold seats: in confirmed orders, or orders whose hold is live. */
export async function passesTaken(tx: Prisma.TransactionClient, ticketTypeId: string, now: Date, exceptOrderId?: string) {
  const sold = await tx.orderLine.aggregate({
    _sum: { quantity: true },
    where: {
      ticketTypeId,
      order: {
        ...(exceptOrderId ? { id: { not: exceptOrderId } } : {}),
        OR: [{ status: OrderStatus.CONFIRMED }, { status: OrderStatus.PENDING, holdExpiresAt: { gt: now } }],
      },
    },
  });
  return sold._sum.quantity ?? 0;
}

const targetKey = (target: SeatTarget) => ("eventId" in target ? `e:${target.eventId}` : `i:${target.eventInstanceId}`);

/**
 * Whether seats released from an order are free again for its registrations
 * (its event or dates already locked): each event's or date's capacity, and
 * each ticket type's limit (per date for date tickets, in passes for passes).
 */
export async function hasFreeSeats(tx: Prisma.TransactionClient, rsvps: Array<{ id: string; orderId: string | null; eventId: string | null; eventInstanceId: string | null; ticketTypeId: string | null; }>, now: Date) {
  if (rsvps.length === 0) return false;
  const others = { id: { notIn: rsvps.map((rsvp) => rsvp.id) }, ...seatTakingWhere(now) };
  const groups = new Map<string, { target: SeatTarget; rsvps: typeof rsvps; }>();
  for (const rsvp of rsvps) {
    const target: SeatTarget | null = rsvp.eventId ? { eventId: rsvp.eventId } : rsvp.eventInstanceId ? { eventInstanceId: rsvp.eventInstanceId } : null;
    if (!target) return false;
    const group = groups.get(targetKey(target)) ?? { target, rsvps: [] };
    group.rsvps.push(rsvp);
    groups.set(targetKey(target), group);
  }
  for (const { target, rsvps: seats } of groups.values()) {
    let capacity: number | null;
    // A cancelled event, series or date has no free seats.
    if ("eventId" in target) {
      const event = await tx.event.findUnique({ where: { id: target.eventId }, select: { capacity: true, status: true } });
      if (!event || event.status === EventStatus.CANCELLED) return false;
      capacity = event.capacity;
    } else {
      const date = await tx.eventInstance.findUnique({ where: { id: target.eventInstanceId }, select: { capacity: true, cancelledAt: true, series: { select: { capacity: true, status: true } } } });
      if (!date || date.cancelledAt || date.series.status === EventStatus.CANCELLED) return false;
      capacity = date.capacity ?? date.series.capacity;
    }
    if (capacity != null && await tx.rSVP.count({ where: { ...target, ...others } }) + seats.length > capacity) return false;
  }
  return ticketTypesFit(tx, rsvps, now);
}

/**
 * Whether each ticket type's limit still has room for these registrations
 * (per event or date for date tickets, in passes for passes), counting
 * everyone else's confirmed places and live holds. Part of hasFreeSeats, and
 * checked on its own where places are counted otherwise (a TEAM event's
 * units, docs/TEAMS.md).
 */
export async function ticketTypesFit(tx: Prisma.TransactionClient, rsvps: Array<{ id: string; orderId: string | null; eventId: string | null; eventInstanceId: string | null; ticketTypeId: string | null; }>, now: Date) {
  const others = { id: { notIn: rsvps.map((rsvp) => rsvp.id) }, ...seatTakingWhere(now) };
  const groups = new Map<string, { target: SeatTarget; rsvps: typeof rsvps; }>();
  for (const rsvp of rsvps) {
    const target = seatTargetOf(rsvp);
    if (!target) continue;
    const group = groups.get(targetKey(target)) ?? { target, rsvps: [] };
    group.rsvps.push(rsvp);
    groups.set(targetKey(target), group);
  }
  const typeIds = [...new Set(rsvps.flatMap((rsvp) => (rsvp.ticketTypeId ? [rsvp.ticketTypeId] : [])))];
  for (const ticketTypeId of typeIds) {
    const type = await tx.ticketType.findUnique({ where: { id: ticketTypeId }, select: { capacity: true, kind: true, seatsPerTicket: true } });
    if (type?.capacity == null) continue;
    if (type.kind === TicketTypeKind.PASS) {
      const ofType = rsvps.filter((rsvp) => rsvp.ticketTypeId === ticketTypeId);
      const passes = ofType.length / Math.max(1, new Set(ofType.map((rsvp) => rsvp.eventInstanceId)).size);
      if (await passesTaken(tx, ticketTypeId, now, rsvps[0]!.orderId ?? undefined) + passes > type.capacity) return false;
      continue;
    }
    for (const { target, rsvps: seats } of groups.values()) {
      // Limits count tickets: a group ticket is one ticket for several people.
      const wanted = Math.ceil(seats.filter((rsvp) => rsvp.ticketTypeId === ticketTypeId).length / type.seatsPerTicket);
      const taken = Math.ceil(await tx.rSVP.count({ where: { ticketTypeId, ...target, ...others } }) / type.seatsPerTicket);
      if (wanted > 0 && taken + wanted > type.capacity) return false;
    }
  }
  return true;
}

/** What a message or page needs to name an order's event, or its series and date. */
export const ORDER_SUBJECT_SELECT = {
  event: { select: { title: true, slug: true, status: true, startDateTime: true, endDateTime: true, timezone: true, organisation: { select: { name: true, slug: true } } } },
  series: { select: { title: true, status: true, timezone: true, organisation: { select: { name: true, slug: true } } } },
  instance: { select: { id: true, startDateTime: true, endDateTime: true, cancelledAt: true } },
} satisfies Prisma.OrderSelect;

type SubjectOrder = Prisma.OrderGetPayload<{ select: typeof ORDER_SUBJECT_SELECT; }>;

export type OrderSubject = {
  title: string;
  start: Date | null;
  end: Date | null;
  timeZone: string;
  organisation: { name: string; slug: string; };
  /** The public page, relative to the site. Null for a pass, which spans dates. */
  path: string | null;
  /** Still taking registrations: published, and the date neither over nor cancelled. */
  open: (now: Date) => boolean;
  pass: boolean;
};

export function orderSubject(order: SubjectOrder): OrderSubject | null {
  if (order.event) {
    const event = order.event;
    return {
      title: event.title, start: event.startDateTime, end: event.endDateTime, timeZone: event.timezone, organisation: event.organisation,
      path: `/${event.organisation.slug}/${event.slug}`,
      open: (now) => event.status === EventStatus.PUBLISHED && event.endDateTime > now,
      pass: false,
    };
  }
  if (!order.series) return null;
  const series = order.series;
  const date = order.instance;
  if (!date) {
    return {
      title: `${series.title} pass`, start: null, end: null, timeZone: series.timezone, organisation: series.organisation, path: null,
      open: () => series.status === EventStatus.PUBLISHED, pass: true,
    };
  }
  return {
    title: titleWith(series.title, dateLabel(date.startDateTime, series.timezone)), start: date.startDateTime, end: date.endDateTime, timeZone: series.timezone, organisation: series.organisation,
    path: `/${series.organisation.slug}/i/${date.id}`,
    open: (now) => series.status === EventStatus.PUBLISHED && date.endDateTime > now && !date.cancelledAt,
    pass: false,
  };
}

/**
 * Whether anything an order sells was cancelled: its event, its series, or a
 * date it holds seats on (a pass reaches its dates through its
 * registrations). Read under the order's target locks.
 */
export async function orderTargetCancelled(tx: Prisma.TransactionClient, order: { event: { status: EventStatus; } | null; series: { status: EventStatus; } | null; instance: { cancelledAt: Date | null; } | null; rsvps: Array<{ eventInstanceId: string | null; }>; }) {
  if (order.event?.status === EventStatus.CANCELLED || order.series?.status === EventStatus.CANCELLED || order.instance?.cancelledAt) return true;
  const dates = [...new Set(order.rsvps.flatMap((rsvp) => (rsvp.eventInstanceId ? [rsvp.eventInstanceId] : [])))];
  return dates.length > 0 && (await tx.eventInstance.count({ where: { id: { in: dates }, cancelledAt: { not: null } } })) > 0;
}

/** The event or date a freed seat belongs to, for the waitlist. */
export function seatTargetOf(rsvp: { eventId: string | null; eventInstanceId: string | null; }): SeatTarget | null {
  return rsvp.eventId ? { eventId: rsvp.eventId } : rsvp.eventInstanceId ? { eventInstanceId: rsvp.eventInstanceId } : null;
}

/** Lock one date (after its series) and read its capacity, whether it still takes registrations, and whether it (or its series) was cancelled. */
export async function lockDate(tx: Prisma.TransactionClient, instanceId: string, now: Date) {
  const date = await tx.eventInstance.findUnique({ where: { id: instanceId }, select: { eventSeriesId: true } });
  if (!date) return null;
  await lockSeriesDates(tx, date.eventSeriesId, [instanceId], now);
  const current = await tx.eventInstance.findUnique({ where: { id: instanceId }, select: { capacity: true, endDateTime: true, cancelledAt: true, series: { select: { capacity: true, status: true } } } });
  if (!current) return null;
  return {
    capacity: current.capacity ?? current.series.capacity,
    open: current.series.status === EventStatus.PUBLISHED && current.endDateTime > now && !current.cancelledAt,
    cancelled: current.series.status === EventStatus.CANCELLED || current.cancelledAt != null,
  };
}
