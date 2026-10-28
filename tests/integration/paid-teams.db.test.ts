import { EventPrivacyType, OrderStatus, PaymentRefundStatus, RsvpStatus, TeamTicketMode } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn().mockResolvedValue(null) }));

import { prisma } from "@/lib/db";
import { runPaymentMaintenance } from "@/lib/payments/maintenance";
import { refundOrder } from "@/lib/payments/operations";
import { submitRsvpCore } from "@/lib/rsvpCore";
import { transitionTeamStatus, removeTeamMember } from "@/lib/core/teams";
import { createTeamEvent, paid, payOrder, setUpPaidOrg, tearDownPaidOrg } from "./helpers/paidOrg";

/*
 * docs/TEAMS.md "Tickets": paid places on team events are paid up front. A
 * leader's team is held (PENDING_PAYMENT) while they pay; a member paying to
 * join has no team until the money lands; PER_TEAM members join free.
 */

type Intent = { mode: "create"; name: string; } | { mode: "join"; joinToken: string; } | { mode: "solo"; };

function register(eventSlug: string, email: string, team: Intent, ticketTypeId?: string) {
  return submitRsvpCore(
    { orgSlug: paid.orgSlug, eventSlug, guestEmail: email, name: "Team Person", answers: {}, ...(ticketTypeId ? { items: [{ ticketTypeId, quantity: 1 }] } : {}) },
    { userId: null, team },
  );
}

const email = (label: string) => `${label}-${paid.suffix}@example.test`;
const orderOf = (email: string) => prisma.order.findFirstOrThrow({ where: { buyerEmail: email }, orderBy: { createdAt: "desc" }, include: { rsvps: true } });
const expire = async (orderId: string) => {
  const past = new Date(Date.now() - 1000);
  await prisma.order.update({ where: { id: orderId }, data: { holdExpiresAt: past } });
  await prisma.rSVP.updateMany({ where: { orderId }, data: { holdExpiresAt: past } });
};

beforeAll(() => setUpPaidOrg("Paid teams"));
afterAll(() => tearDownPaidOrg());

describe.sequential("paid team registration", () => {
  it("holds a leader's new team while they pay, then confirms it and emails the team page link", async () => {
    const { event, ticket } = await createTeamEvent();
    const created = await register(event.slug, email("lead-a"), { mode: "create", name: "Rockets" }, ticket.id);
    expect(created).toMatchObject({ ok: true, data: { status: RsvpStatus.PENDING_PAYMENT, checkoutUrl: expect.stringMatching(/^https:/) } });
    const order = await orderOf(email("lead-a"));
    const team = await prisma.team.findFirstOrThrow({ where: { eventId: event.id } });
    expect(team).toMatchObject({ name: "Rockets", status: RsvpStatus.PENDING_PAYMENT, leaderRsvpId: order.rsvps[0]!.id });
    expect(order).toMatchObject({ teamId: team.id, teamName: "Rockets", status: OrderStatus.PENDING });

    // Nobody can join or take the name while the leader pays.
    expect(await register(event.slug, email("join-early"), { mode: "join", joinToken: team.joinToken }, ticket.id)).toMatchObject({ ok: false, error: expect.stringContaining("still paying") });
    expect(await register(event.slug, email("lead-b"), { mode: "create", name: "rockets" }, ticket.id)).toMatchObject({ ok: false, error: expect.stringContaining("already taken") });

    expect((await payOrder(order.id)).outcome).toBe("confirmed");
    expect(await prisma.team.findUniqueOrThrow({ where: { id: team.id } })).toMatchObject({ status: RsvpStatus.CONFIRMED });
    expect(await prisma.rSVP.findUniqueOrThrow({ where: { id: order.rsvps[0]!.id } })).toMatchObject({ status: RsvpStatus.CONFIRMED, teamId: team.id });
    expect(await prisma.outboxMessage.count({ where: { kind: "team-created", payload: { path: ["teamId"], equals: team.id } } })).toBe(1);
  });

  it("puts a PER_MEMBER joiner in the team only once their ticket is paid", async () => {
    const { event, ticket } = await createTeamEvent();
    await register(event.slug, email("lead-c"), { mode: "create", name: "Comets" }, ticket.id);
    await payOrder((await orderOf(email("lead-c"))).id);
    const team = await prisma.team.findFirstOrThrow({ where: { eventId: event.id } });
    expect(await register(event.slug, email("member-c"), { mode: "join", joinToken: team.joinToken }, ticket.id)).toMatchObject({ ok: true, data: { status: RsvpStatus.PENDING_PAYMENT } });
    const joining = await orderOf(email("member-c"));
    expect(joining).toMatchObject({ teamId: team.id, teamName: null });
    expect(joining.rsvps[0]).toMatchObject({ teamId: null, status: RsvpStatus.PENDING_PAYMENT });
    // A member paying doesn't take a unit; leaders can't add people for free.
    await payOrder(joining.id);
    expect(await prisma.rSVP.findUniqueOrThrow({ where: { id: joining.rsvps[0]!.id } })).toMatchObject({ teamId: team.id, status: RsvpStatus.CONFIRMED });
    // A paid member can't be removed by the leader; they cancel as an order.
    const removed = await removeTeamMember({ kind: "token", teamId: team.id, eventId: event.id, manageTokenHash: team.manageTokenHash }, joining.rsvps[0]!.id);
    expect(removed).toMatchObject({ ok: false, error: expect.stringContaining("paid") });
  });

  it("counts a held team as a unit, and frees the unit and the name when the hold ends", async () => {
    const { event, ticket } = await createTeamEvent({ capacity: 1 });
    await register(event.slug, email("lead-d"), { mode: "create", name: "Meteors" }, ticket.id);
    expect(await register(event.slug, email("lead-e"), { mode: "create", name: "Novas" }, ticket.id)).toMatchObject({ ok: false, error: "There are no places left for new teams." });
    await expire((await orderOf(email("lead-d"))).id);
    await runPaymentMaintenance();
    expect(await prisma.team.count({ where: { eventId: event.id } })).toBe(0);
    expect(await register(event.slug, email("lead-e"), { mode: "create", name: "Meteors" }, ticket.id)).toMatchObject({ ok: true, data: { status: RsvpStatus.PENDING_PAYMENT } });
  });

  it("refunds a late payment when the team is gone", async () => {
    const { event, ticket } = await createTeamEvent({ capacity: 1 });
    await register(event.slug, email("lead-f"), { mode: "create", name: "Quasars" }, ticket.id);
    const order = await orderOf(email("lead-f"));
    await expire(order.id);
    await prisma.team.deleteMany({ where: { eventId: event.id } });
    expect((await payOrder(order.id)).outcome).toBe("refunding");
  });

  it("lets PER_TEAM members join free once the leader has paid, and cancels the whole team with the leader's order", async () => {
    const { event, ticket } = await createTeamEvent({ mode: TeamTicketMode.PER_TEAM });
    await register(event.slug, email("lead-g"), { mode: "create", name: "Pulsars" }, ticket.id);
    const order = await orderOf(email("lead-g"));
    const team = await prisma.team.findFirstOrThrow({ where: { eventId: event.id } });
    expect(await register(event.slug, email("member-g0"), { mode: "join", joinToken: team.joinToken })).toMatchObject({ ok: false, error: expect.stringContaining("still paying") });
    await payOrder(order.id);
    expect(await register(event.slug, email("member-g"), { mode: "join", joinToken: team.joinToken })).toMatchObject({ ok: true, data: { status: RsvpStatus.CONFIRMED } });
    const member = await prisma.rSVP.findFirstOrThrow({ where: { guestEmail: email("member-g") } });
    expect(member).toMatchObject({ teamId: team.id, orderId: null });

    await refundOrder({ orderId: order.id, organisationId: paid.organisationId, actorUserId: null, amountMinor: null, reason: "Test", cancelTickets: true });
    expect(await prisma.team.count({ where: { id: team.id } })).toBe(0);
    expect(await prisma.rSVP.count({ where: { eventId: event.id } })).toBe(0);
  });

  it("pays first on an approval event, waits for approval, and refunds everyone when the team is rejected", async () => {
    const { event, ticket } = await createTeamEvent({ privacyType: EventPrivacyType.APPROVAL_REQUIRED });
    await register(event.slug, email("lead-h"), { mode: "create", name: "Nebulae" }, ticket.id);
    const order = await orderOf(email("lead-h"));
    expect(order.status).toBe(OrderStatus.PENDING);
    await payOrder(order.id);
    const team = await prisma.team.findFirstOrThrow({ where: { eventId: event.id } });
    expect(team.status).toBe(RsvpStatus.PENDING_APPROVAL);
    await register(event.slug, email("member-h"), { mode: "join", joinToken: team.joinToken }, ticket.id);
    await payOrder((await orderOf(email("member-h"))).id);
    expect(await prisma.rSVP.count({ where: { teamId: team.id, status: RsvpStatus.PENDING_APPROVAL } })).toBe(2);

    const organiser = await prisma.user.create({ data: { email: email("organiser-h") } });
    const rejected = await transitionTeamStatus({ userId: organiser.id, organisationId: paid.organisationId, orgSlug: paid.orgSlug, eventId: event.id, eventSlug: event.slug }, team.id, "reject");
    expect(rejected).toMatchObject({ ok: true, data: { status: RsvpStatus.REJECTED } });
    const refunds = await prisma.paymentRefund.findMany({ where: { payment: { order: { eventId: event.id } } } });
    expect(refunds).toHaveLength(2);
    expect(refunds.every((refund) => refund.amountMinor === BigInt(49900) && refund.status !== PaymentRefundStatus.FAILED)).toBe(true);
    await prisma.user.delete({ where: { id: organiser.id } });
  });

  it("refunds a member who paid to join a team that was deleted meanwhile, and keeps desk payment off approval events", async () => {
    const { event, ticket } = await createTeamEvent();
    await register(event.slug, email("lead-i"), { mode: "create", name: "Orbits" }, ticket.id);
    await payOrder((await orderOf(email("lead-i"))).id);
    const team = await prisma.team.findFirstOrThrow({ where: { eventId: event.id } });
    await register(event.slug, email("member-i"), { mode: "join", joinToken: team.joinToken }, ticket.id);
    const joining = await orderOf(email("member-i"));
    expect(joining.teamJoin).toBe(true);
    await prisma.rSVP.deleteMany({ where: { teamId: team.id } });
    await prisma.team.delete({ where: { id: team.id } });
    expect((await payOrder(joining.id)).outcome).toBe("refunding");
    expect(await prisma.rSVP.findUniqueOrThrow({ where: { id: joining.rsvps[0]!.id } })).toMatchObject({ teamId: null, status: RsvpStatus.PENDING_PAYMENT });

    const approval = await createTeamEvent({ privacyType: EventPrivacyType.APPROVAL_REQUIRED });
    await prisma.ticketType.update({ where: { id: approval.ticket.id }, data: { payAtDesk: true } });
    const desk = await submitRsvpCore({ orgSlug: paid.orgSlug, eventSlug: approval.event.slug, guestEmail: email("desk-i"), name: "Desk", answers: {}, items: [{ ticketTypeId: approval.ticket.id, quantity: 1 }], payAtDesk: true }, { userId: null, team: { mode: "create", name: "Deskers" } });
    expect(desk).toMatchObject({ ok: false, error: expect.stringContaining("pay online") });
  });
});
