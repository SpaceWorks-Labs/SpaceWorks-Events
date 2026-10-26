"use server";

import type { ActionResult } from "@/app/actions/org";
import { recordAuditEvent } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { isPaidEventsEnabled } from "@/lib/instanceSettings";
import { DEFAULT_CURRENCY, formatMoney, parseMoneyToMinor, providerMinimumMinor } from "@/lib/payments/money";
import { isValidPromoCode, promoCodeDigest, promoCodeHint } from "@/lib/payments/promo";
import { isAtLeastAsGenerous, type RefundPolicySnapshot } from "@/lib/payments/refundPolicy";
import { configuredProvider } from "@/lib/payments/settings";
import { access, revalidateOwner, setOwnerCurrency } from "./ticket-types/access";
import { addOnSchema, archiveAddOnSchema, archivePromoSchema, archiveSchema, promoSchema, refundPolicySchema, saveSchema, teamTicketModeSchema, transferSchema } from "./ticket-types/schemas";

const MAX_TICKET_TYPES = 20;
const ZERO = BigInt(0);

export async function saveTicketType(input: unknown): Promise<ActionResult<{ id: string; }>> {
  const parsed = saveSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the ticket details." };
  const context = await access(parsed.data);
  if ("error" in context) return { ok: false, error: context.error };
  const { organisation, userId, owner } = context;
  const data = parsed.data;
  if ("eventId" in owner && data.kind === "PASS") return { ok: false, error: "Passes are for series." };
  // On a team event each person (or each team, docs/TEAMS.md) holds one ticket.
  if ("eventId" in owner && data.seatsPerTicket > 1 && (await prisma.event.count({ where: { id: owner.eventId, registrationMode: "TEAM" } })) > 0) return { ok: false, error: "Group tickets aren't available on team events: each person registers for themselves." };

  const existing = data.ticketTypeId
    ? await prisma.ticketType.findFirst({ where: { id: data.ticketTypeId, ...owner, archivedAt: null }, select: { id: true, accessCodeDigest: true, accessCodeHint: true } })
    : null;
  if (data.ticketTypeId && !existing) return { ok: false, error: "That ticket no longer exists." };

  const settings = await prisma.organisationPaymentSettings.findUnique({ where: { organisationId: organisation.id } });
  // One currency per event: set with its first ticket and never changed after,
  // so every ticket, order and refund of the event agrees.
  const currency = context.currency ?? settings?.currency ?? DEFAULT_CURRENCY;
  const priceMinor = data.price ? parseMoneyToMinor(data.price, currency) : ZERO;
  if (priceMinor === null) return { ok: false, error: `Enter the price in ${currency}, for example 499 or 499.50.` };
  const money = (value: string | undefined) => (value ? parseMoneyToMinor(value, currency) : null);
  const flexible = data.pricing === "FLEXIBLE";
  const suggestedMinor = flexible ? money(data.suggested) : null;
  const maxPriceMinor = flexible ? money(data.maxPrice) : null;
  const feeMinor = money(data.fee) ?? ZERO;
  if ((flexible && data.suggested && suggestedMinor === null) || (flexible && data.maxPrice && maxPriceMinor === null) || (data.fee && money(data.fee) === null)) {
    return { ok: false, error: `Enter amounts in ${currency}, for example 499 or 499.50.` };
  }
  if (suggestedMinor != null && suggestedMinor < priceMinor) return { ok: false, error: "The suggested price can't be below the minimum." };
  if (maxPriceMinor != null && maxPriceMinor < (suggestedMinor ?? priceMinor)) return { ok: false, error: "The most a buyer may pay can't be below the minimum or the suggestion." };

  // Access codes are stored as a digest: a new code replaces the old one.
  let accessCodeDigest: string | null = null;
  let accessCodeHint: string | null = null;
  if (data.visibility === "CODE") {
    if (data.accessCode) {
      if (!isValidPromoCode(data.accessCode)) return { ok: false, error: "Access codes are 3 to 32 letters, numbers, - or _." };
      accessCodeDigest = promoCodeDigest(data.accessCode);
      accessCodeHint = promoCodeHint(data.accessCode);
    } else if (existing?.accessCodeDigest) {
      accessCodeDigest = existing.accessCodeDigest;
      accessCodeHint = existing.accessCodeHint;
    } else {
      return { ok: false, error: "Enter the access code buyers will use." };
    }
  }

  // Anything that can take money needs paid events on and a connected account.
  if (priceMinor > ZERO || flexible || feeMinor > ZERO) {
    if (!(await isPaidEventsEnabled())) return { ok: false, error: "Paid tickets are turned off on this installation." };
    const provider = configuredProvider(settings);
    if (!provider) return { ok: false, error: "Connect a payment account in Settings → Payments before adding a paid ticket." };
    const minimum = providerMinimumMinor(provider, currency);
    if (priceMinor > ZERO && priceMinor < minimum) return { ok: false, error: `The smallest price ${provider === "RAZORPAY" ? "Razorpay" : "Stripe"} accepts is ${formatMoney(minimum, currency)}.` };
  }
  if (data.maxPerOrder < data.minPerOrder) return { ok: false, error: "The most per order can't be below the fewest." };
  const salesStartAt = data.salesStartAt ? new Date(data.salesStartAt) : null;
  const salesEndAt = data.salesEndAt ? new Date(data.salesEndAt) : null;
  if (salesStartAt && salesEndAt && salesEndAt <= salesStartAt) return { ok: false, error: "Sales must end after they start." };

  const values = {
    name: data.name,
    description: data.description,
    priceMinor,
    capacity: data.capacity ?? null,
    minPerOrder: data.minPerOrder,
    maxPerOrder: data.maxPerOrder,
    salesStartAt,
    salesEndAt,
    visibility: data.visibility,
    accessCodeDigest,
    accessCodeHint,
    pricing: data.pricing,
    suggestedMinor,
    maxPriceMinor,
    seatsPerTicket: data.seatsPerTicket,
    feeMinor,
    payAtDesk: data.payAtDesk,
  };
  const saved = await prisma.$transaction(async (tx) => {
    let id: string;
    if (existing) {
      // Registrations keep the price they were quoted; only new ones change.
      await tx.ticketType.update({ where: { id: existing.id }, data: values });
      id = existing.id;
    } else {
      if (await tx.ticketType.count({ where: { ...owner, archivedAt: null } }) >= MAX_TICKET_TYPES) return null;
      const last = await tx.ticketType.findFirst({ where: owner, orderBy: { sortOrder: "desc" }, select: { sortOrder: true } });
      id = (await tx.ticketType.create({ data: { ...values, ...owner, kind: data.kind, sortOrder: (last?.sortOrder ?? -1) + 1 }, select: { id: true } })).id;
      if (!context.currency) await setOwnerCurrency(tx, owner, currency);
    }
    await recordAuditEvent({
      action: existing ? "TICKET_TYPE_UPDATED" : "TICKET_TYPE_CREATED",
      actorUserId: userId,
      organisationId: organisation.id,
      targetType: "TicketType",
      targetId: id,
      metadata: { paid: priceMinor > ZERO, limited: values.capacity != null, pass: data.kind === "PASS", visibility: data.visibility, flexible, group: data.seatsPerTicket > 1, fee: feeMinor > ZERO },
      client: tx,
    });
    return id;
  });
  if (!saved) return { ok: false, error: `An event can have up to ${MAX_TICKET_TYPES} tickets.` };
  revalidateOwner(context);
  return { ok: true, data: { id: saved } };
}

/** Takes a ticket off sale. Registrations keep it; it is never deleted. */
export async function archiveTicketType(input: unknown): Promise<ActionResult> {
  const parsed = archiveSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Choose a ticket." };
  const context = await access(parsed.data);
  if ("error" in context) return { ok: false, error: context.error };
  const archived = await prisma.ticketType.updateMany({
    where: { id: parsed.data.ticketTypeId, ...context.owner, archivedAt: null },
    data: { archivedAt: new Date() },
  });
  if (archived.count !== 1) return { ok: false, error: "That ticket no longer exists." };
  await recordAuditEvent({ action: "TICKET_TYPE_ARCHIVED", actorUserId: context.userId, organisationId: context.organisation.id, targetType: "TicketType", targetId: parsed.data.ticketTypeId });
  revalidateOwner(context);
  return { ok: true };
}

/**
 * Create a promo code. Only a digest of the code is stored, with a short
 * hint; a code is never edited, only archived and replaced.
 */
export async function createPromoCode(input: unknown): Promise<ActionResult<{ id: string; }>> {
  const parsed = promoSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the promo code." };
  const context = await access(parsed.data);
  if ("error" in context) return { ok: false, error: context.error };
  const { organisation, userId, owner, currency } = context;
  const data = parsed.data;
  if (!isValidPromoCode(data.code)) return { ok: false, error: "Codes are 3 to 32 letters, numbers, - or _." };
  if (!currency) return { ok: false, error: "Add a paid ticket before creating promo codes." };
  let amountOffMinor: bigint | null = null;
  if (data.kind === "FIXED") {
    amountOffMinor = data.amountOff ? parseMoneyToMinor(data.amountOff, currency) : null;
    if (!amountOffMinor || amountOffMinor <= ZERO) return { ok: false, error: `Enter the discount in ${currency}, for example 100.` };
  } else if (!data.percentOff) {
    return { ok: false, error: "Enter a percentage from 1 to 100." };
  }
  if (data.ticketTypeId && !(await prisma.ticketType.findFirst({ where: { id: data.ticketTypeId, ...owner, archivedAt: null }, select: { id: true } }))) {
    return { ok: false, error: "That ticket no longer exists." };
  }
  const validFrom = data.validFrom ? new Date(data.validFrom) : null;
  const validUntil = data.validUntil ? new Date(data.validUntil) : null;
  if (validFrom && validUntil && validUntil <= validFrom) return { ok: false, error: "The code must stop working after it starts." };
  try {
    const created = await prisma.promoCode.create({
      data: {
        ...owner, codeDigest: promoCodeDigest(data.code), hint: promoCodeHint(data.code), kind: data.kind, appliesPer: data.appliesPer,
        percentOff: data.kind === "PERCENT" ? data.percentOff : null, amountOffMinor, ticketTypeId: data.ticketTypeId ?? null,
        minQuantity: data.minQuantity, perOrderLimit: data.appliesPer === "TICKET" ? data.perOrderLimit ?? null : null, maxRedemptions: data.maxRedemptions ?? null,
        validFrom, validUntil, createdByUserId: userId,
      },
      select: { id: true },
    });
    await recordAuditEvent({ action: "PROMO_CODE_CREATED", actorUserId: userId, organisationId: organisation.id, targetType: "PromoCode", targetId: created.id, metadata: { kind: data.kind, appliesPer: data.appliesPer } });
    revalidateOwner(context);
    return { ok: true, data: { id: created.id } };
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && (error as { code: string }).code === "P2002") return { ok: false, error: "This event already has that code." };
    throw error;
  }
}

/** Stops a code working. Orders that used it keep their price. */
export async function archivePromoCode(input: unknown): Promise<ActionResult> {
  const parsed = archivePromoSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Choose a promo code." };
  const context = await access(parsed.data);
  if ("error" in context) return { ok: false, error: context.error };
  const archived = await prisma.promoCode.updateMany({ where: { id: parsed.data.promoCodeId, ...context.owner, archivedAt: null }, data: { archivedAt: new Date() } });
  if (archived.count !== 1) return { ok: false, error: "That code is already off." };
  await recordAuditEvent({ action: "PROMO_CODE_ARCHIVED", actorUserId: context.userId, organisationId: context.organisation.id, targetType: "PromoCode", targetId: parsed.data.promoCodeId });
  revalidateOwner(context);
  return { ok: true };
}

/**
 * Set when buyers may cancel for a refund. Each order keeps the policy it
 * was sold under; once any paid order exists the policy may only become
 * more generous, so what was advertised is never taken back.
 */
export async function saveRefundPolicy(input: unknown): Promise<ActionResult> {
  const parsed = refundPolicySchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the refund policy." };
  const context = await access(parsed.data);
  if ("error" in context) return { ok: false, error: context.error };
  const { owner } = context;
  const data = parsed.data;
  const next: RefundPolicySnapshot = {
    kind: data.kind,
    hours: data.kind === "NONE" ? null : data.hours ?? null,
    percent: data.kind === "PERCENT_UNTIL" ? data.percent ?? null : null,
    text: data.text,
  };
  if (next.kind !== "NONE" && next.hours == null) return { ok: false, error: "Say how long before the event refunds stop." };
  if (next.kind === "PERCENT_UNTIL" && next.percent == null) return { ok: false, error: "Enter the refund percentage, from 1 to 99." };
  const result = await prisma.$transaction(async (tx) => {
    const policy = { refundPolicyKind: true, refundPolicyHours: true, refundPolicyPercent: true, refundPolicyText: true } as const;
    let current;
    if ("eventId" in owner) {
      await tx.$queryRaw`SELECT "id" FROM "Event" WHERE "id" = ${owner.eventId} FOR UPDATE`;
      current = await tx.event.findUniqueOrThrow({ where: { id: owner.eventId }, select: policy });
    } else {
      await tx.$queryRaw`SELECT "id" FROM "EventSeries" WHERE "id" = ${owner.eventSeriesId} FOR UPDATE`;
      current = await tx.eventSeries.findUniqueOrThrow({ where: { id: owner.eventSeriesId }, select: policy });
    }
    const sold = await tx.order.count({ where: { ...owner, totalMinor: { gt: 0 } } });
    const previous: RefundPolicySnapshot = { kind: current.refundPolicyKind, hours: current.refundPolicyHours, percent: current.refundPolicyPercent, text: current.refundPolicyText };
    if (sold > 0 && !isAtLeastAsGenerous(next, previous)) return "stricter" as const;
    const values = { refundPolicyKind: next.kind, refundPolicyHours: next.hours, refundPolicyPercent: next.percent, refundPolicyText: next.text };
    if ("eventId" in owner) await tx.event.update({ where: { id: owner.eventId }, data: values });
    else await tx.eventSeries.update({ where: { id: owner.eventSeriesId }, data: values });
    await recordAuditEvent({ action: "REFUND_POLICY_UPDATED", actorUserId: context.userId, organisationId: context.organisation.id, targetType: "eventId" in owner ? "Event" : "EventSeries", targetId: "eventId" in owner ? owner.eventId : owner.eventSeriesId, metadata: { kind: next.kind }, client: tx });
    return "saved" as const;
  });
  if (result === "stricter") return { ok: false, error: "Tickets have been sold, so the refund policy can only become more generous." };
  revalidateOwner(context);
  return { ok: true };
}

/** Add or change an extra sold alongside tickets (a T-shirt, lunch, a donation). It takes no seat. */
export async function saveAddOn(input: unknown): Promise<ActionResult<{ id: string; }>> {
  const parsed = addOnSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the extra." };
  const context = await access(parsed.data);
  if ("error" in context) return { ok: false, error: context.error };
  const { organisation, userId, owner } = context;
  const data = parsed.data;
  const settings = await prisma.organisationPaymentSettings.findUnique({ where: { organisationId: organisation.id } });
  const currency = context.currency ?? settings?.currency ?? DEFAULT_CURRENCY;
  const priceMinor = data.price ? parseMoneyToMinor(data.price, currency) : ZERO;
  if (priceMinor === null) return { ok: false, error: `Enter the price in ${currency}, for example 299.` };
  if (priceMinor > ZERO && (!(await isPaidEventsEnabled()) || !configuredProvider(settings))) return { ok: false, error: "Connect a payment account in Settings → Payments before selling paid extras." };
  const values = { name: data.name, description: data.description, priceMinor, capacity: data.capacity ?? null, maxPerOrder: data.maxPerOrder };
  const saved = await prisma.$transaction(async (tx) => {
    if (data.addOnId) {
      const updated = await tx.addOn.updateMany({ where: { id: data.addOnId, ...owner, archivedAt: null }, data: values });
      if (updated.count !== 1) return null;
      return data.addOnId;
    }
    const last = await tx.addOn.findFirst({ where: owner, orderBy: { sortOrder: "desc" }, select: { sortOrder: true } });
    const created = await tx.addOn.create({ data: { ...values, ...owner, sortOrder: (last?.sortOrder ?? -1) + 1 }, select: { id: true } });
    if (!context.currency) await setOwnerCurrency(tx, owner, currency);
    return created.id;
  });
  if (!saved) return { ok: false, error: "That extra no longer exists." };
  await recordAuditEvent({ action: data.addOnId ? "ADD_ON_UPDATED" : "ADD_ON_CREATED", actorUserId: userId, organisationId: organisation.id, targetType: "AddOn", targetId: saved, metadata: { paid: priceMinor > ZERO } });
  revalidateOwner(context);
  return { ok: true, data: { id: saved } };
}

/** Stop selling an extra. Orders keep what they bought. */
export async function archiveAddOn(input: unknown): Promise<ActionResult> {
  const parsed = archiveAddOnSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Choose an extra." };
  const context = await access(parsed.data);
  if ("error" in context) return { ok: false, error: context.error };
  const archived = await prisma.addOn.updateMany({ where: { id: parsed.data.addOnId, ...context.owner, archivedAt: null }, data: { archivedAt: new Date() } });
  if (archived.count !== 1) return { ok: false, error: "That extra is already off sale." };
  await recordAuditEvent({ action: "ADD_ON_ARCHIVED", actorUserId: context.userId, organisationId: context.organisation.id, targetType: "AddOn", targetId: parsed.data.addOnId });
  revalidateOwner(context);
  return { ok: true };
}

/** Whether ticket holders may give their tickets to someone else, and until how long before the start. */
export async function saveTransferPolicy(input: unknown): Promise<ActionResult> {
  const parsed = transferSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the transfer setting." };
  const context = await access(parsed.data);
  if ("error" in context) return { ok: false, error: context.error };
  const data = { allowTransfers: parsed.data.allowTransfers, transferCutoffHours: parsed.data.cutoffHours };
  if ("eventId" in context.owner) await prisma.event.update({ where: { id: context.owner.eventId }, data });
  else await prisma.eventSeries.update({ where: { id: context.owner.eventSeriesId }, data });
  await recordAuditEvent({ action: "TRANSFER_POLICY_UPDATED", actorUserId: context.userId, organisationId: context.organisation.id, targetType: "eventId" in context.owner ? "Event" : "EventSeries", targetId: "eventId" in context.owner ? context.owner.eventId : context.owner.eventSeriesId, metadata: data });
  revalidateOwner(context);
  return { ok: true };
}

/** Who pays on a team event (docs/TEAMS.md): every member, or the leader once for the team. Fixed after the first sale. */
export async function saveTeamTicketMode(input: unknown): Promise<ActionResult> {
  const parsed = teamTicketModeSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Choose who pays." };
  const context = await access(parsed.data);
  if ("error" in context || !("eventId" in context.owner)) return { ok: false, error: "error" in context ? context.error : "Event not found." };
  const eventId = context.owner.eventId;
  const saved = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Event" WHERE "id" = ${eventId} FOR UPDATE`;
    const event = await tx.event.findUnique({ where: { id: eventId }, select: { registrationMode: true, teamTicketMode: true } });
    if (event?.registrationMode !== "TEAM") return "This event doesn't register teams.";
    if (event.teamTicketMode === parsed.data.mode) return null;
    if (await tx.order.count({ where: { eventId, totalMinor: { gt: 0 } } }) > 0) return "Who pays can't change once tickets have been sold.";
    await tx.event.update({ where: { id: eventId }, data: { teamTicketMode: parsed.data.mode } });
    await recordAuditEvent({ action: "TEAM_TICKET_MODE_UPDATED", actorUserId: context.userId, organisationId: context.organisation.id, targetType: "Event", targetId: eventId, metadata: { mode: parsed.data.mode }, client: tx });
    return null;
  });
  if (saved) return { ok: false, error: saved };
  revalidateOwner(context);
  return { ok: true };
}
