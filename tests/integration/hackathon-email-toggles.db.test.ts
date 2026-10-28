import { randomUUID } from "node:crypto";
import { EventPermission, EventStatus, JudgingStatus, MembershipRole, RegistrationMode, SoloPolicy, type Event } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const identity = vi.hoisted(() => ({ id: "" }));
vi.mock("@/lib/auth", () => ({ auth: async () => (identity.id ? { user: { id: identity.id } } : null) }));
vi.mock("@/lib/actionRateLimit", () => ({ isActionRateLimited: async () => false }));
vi.mock("@/lib/outboxWorker", () => ({ startOutboxWorker: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/db";
import { submitRsvpCore } from "@/lib/rsvpCore";
import { hashTeamManageToken } from "@/lib/teamToken";
import { resolveJudgingOrganiser, type JudgingOrganiserContext } from "@/lib/judgingAccess";
import {
  countResultsAnnouncementRecipients,
  createJudgingCriterion,
  loadJudgingSetup,
  publishResults,
  requestSubmissionLink,
  resolveEntrantByTeamManageToken,
  sendResultsAnnouncement,
  setJudgingStatus,
  submitSubmission,
  unpublishResults,
  updateJudgingSettings,
  withdrawSubmission,
} from "@/lib/core/judging";
import { publishJudgingResults, saveJudgingSettings, sendResultsAnnouncement as sendResultsAnnouncementAction } from "@/app/actions/judging-admin";
import { cloneEvent } from "@/app/actions/event";
import { announcedBefore, resultsAnnouncementState } from "@/lib/hackathonEmails";

/*
 * Hackathon emails are opt-in per event (docs/HACKATHON.md → Hackathon
 * emails, lib/hackathonEmails.ts): `results-published` and
 * `submission-received` are queued only when an organiser turns them on,
 * while registration and capability emails always go out. The entry-fee
 * receipt and the money emails are covered in
 * hackathon-email-toggles-fees.db.test.ts.
 */

const suffix = randomUUID().replaceAll("-", "");
const orgSlug = `emails-${suffix}`;
const otherOrgSlug = `emails-other-${suffix}`;
const startedAt = new Date();
const HOUR = 3_600_000;
const ids = { organisation: "", otherOrganisation: "", organiser: "", otherOrganiser: "", coOrganiser: "" };
let sequence = 0;

async function createEvent(): Promise<Event> {
  return prisma.event.create({
    data: {
      organisationId: ids.organisation,
      title: `Emails ${suffix}`,
      slug: `emails-${suffix}-${randomUUID().slice(0, 8)}`,
      startDateTime: new Date(Date.now() + 24 * HOUR),
      endDateTime: new Date(Date.now() + 48 * HOUR),
      timezone: "UTC",
      status: EventStatus.PUBLISHED,
      registrationMode: RegistrationMode.TEAM,
      teamMaxSize: 4,
      soloPolicy: SoloPolicy.SOLO_ALLOWED,
      page: { create: { isPublished: true } },
    },
  });
}

async function register(event: Event, label: string, team?: { mode: "create"; name: string } | { mode: "join"; joinToken: string }) {
  sequence += 1;
  const result = await submitRsvpCore(
    { orgSlug, eventSlug: event.slug, guestEmail: `${label}-${sequence}-${suffix}@example.test`, name: `${label} Person`, answers: {} },
    { userId: null, ...(team ? { team } : {}) },
  );
  if (!result.ok || !result.data) throw new Error(`registration failed: ${result.ok ? "no data" : result.error}`);
  return prisma.rSVP.findUniqueOrThrow({ where: { checkInToken: result.data.ticketToken } });
}

async function teamAuth(teamId: string) {
  const team = await prisma.team.findUniqueOrThrow({ where: { id: teamId } });
  const messages = await prisma.outboxMessage.findMany({ where: { kind: "team-created", payload: { path: ["teamId"], equals: teamId } } });
  const token = messages.map((m) => (m.payload as { manageToken?: string }).manageToken).find((raw) => raw && hashTeamManageToken(raw) === team.manageTokenHash);
  const auth = token ? await resolveEntrantByTeamManageToken(token) : null;
  if (!auth) throw new Error("entrant missing");
  return auth;
}

async function organiser(event: Event): Promise<JudgingOrganiserContext> {
  const ctx = await resolveJudgingOrganiser(ids.organiser, orgSlug, event.id);
  if (!ctx) throw new Error("organiser context missing");
  return ctx;
}

type Switches = { emailEntrantsOnResults?: boolean; emailSubmissionReceipts?: boolean };

const windowSettings = () => ({
  submissionsEnabled: true,
  submissionsOpenAt: new Date(Date.now() - HOUR).toISOString(),
  submissionsCloseAt: new Date(Date.now() + HOUR).toISOString(),
  judgesSeeAll: true,
  projectGalleryPublic: false,
});

const save = (ctx: JudgingOrganiserContext, switches: Switches = {}) => updateJudgingSettings(ctx, { ...windowSettings(), ...switches });

/** A team of two and a solo registrant, all confirmed, one submitted project, judging CLOSED. */
async function readyToPublish(switches: Switches = {}) {
  const event = await createEvent();
  const ctx = await organiser(event);
  expect((await save(ctx, switches)).ok).toBe(true);
  const leader = await register(event, "leader", { mode: "create", name: `Team ${randomUUID().slice(0, 6)}` });
  const team = await prisma.team.findUniqueOrThrow({ where: { id: leader.teamId! } });
  const member = await register(event, "member", { mode: "join", joinToken: team.joinToken });
  const solo = await register(event, "solo");
  expect(await submitSubmission(await teamAuth(team.id), { title: "Project" })).toMatchObject({ ok: true });
  expect((await createJudgingCriterion(ctx, { name: "Impact", weight: 1, maxScore: 5 })).ok).toBe(true);
  expect(await setJudgingStatus(ctx, JudgingStatus.OPEN)).toMatchObject({ ok: true });
  expect(await setJudgingStatus(ctx, JudgingStatus.CLOSED)).toMatchObject({ ok: true });
  const addresses = [leader, member, solo].map((rsvp) => rsvp.guestEmail!.toLowerCase()).sort();
  return { event, ctx, addresses };
}

const announcementsFor = (eventId: string) => ({ kind: "results-published", payload: { path: ["eventId"], equals: eventId } });
const announcedTo = async (eventId: string) =>
  (await prisma.outboxMessage.findMany({ where: announcementsFor(eventId), select: { payload: true } })).map((row) => (row.payload as { to: string }).to).sort();
const switchesOf = (id: string) => prisma.event.findUniqueOrThrow({ where: { id }, select: { emailEntrantsOnResults: true, emailSubmissionReceipts: true } });
const BOTH_OFF = { emailEntrantsOnResults: false, emailSubmissionReceipts: false };
const queuedOf = (results: Array<{ ok: boolean; data?: { queued: number } }>) => results.map((result) => (result.ok ? result.data!.queued : -1)).sort((a, b) => a - b);

describe.sequential("hackathon email toggles", () => {
  beforeAll(async () => {
    const [org, otherOrg] = await Promise.all([
      prisma.organisation.create({ data: { name: `Emails ${suffix}`, slug: orgSlug } }),
      prisma.organisation.create({ data: { name: `Emails other ${suffix}`, slug: otherOrgSlug } }),
    ]);
    ids.organisation = org.id;
    ids.otherOrganisation = otherOrg.id;
    const [owner, otherOwner, coOrganiser] = await Promise.all(
      ["organiser", "other", "co-organiser"].map((label) => prisma.user.create({ data: { name: label, email: `${label}-${suffix}@example.test`, emailVerified: new Date() } })),
    );
    ids.organiser = owner!.id;
    ids.otherOrganiser = otherOwner!.id;
    ids.coOrganiser = coOrganiser!.id;
    await prisma.membership.createMany({
      data: [
        { userId: ids.organiser, organisationId: ids.organisation, role: MembershipRole.ADMIN },
        { userId: ids.otherOrganiser, organisationId: ids.otherOrganisation, role: MembershipRole.OWNER },
      ],
    });
  });

  afterAll(async () => {
    identity.id = "";
    await prisma.organisation.deleteMany({ where: { id: { in: [ids.organisation, ids.otherOrganisation].filter(Boolean) } } });
    await prisma.user.deleteMany({ where: { id: { in: [ids.organiser, ids.otherOrganiser, ids.coOrganiser].filter(Boolean) } } });
    await prisma.outboxMessage.deleteMany({ where: { createdAt: { gte: startedAt } } });
    await prisma.auditEvent.deleteMany({ where: { createdAt: { gte: startedAt }, action: { startsWith: "JUDGING_" } } });
    await prisma.$disconnect();
  });

  it("defaults both switches to false, as NOT NULL DEFAULT false columns", async () => {
    const event = await createEvent();
    expect(await switchesOf(event.id)).toEqual(BOTH_OFF);
    const columns = await prisma.$queryRaw<Array<{ column_name: string; is_nullable: string; column_default: string | null }>>`
      SELECT column_name, is_nullable, column_default FROM information_schema.columns
      WHERE table_name = 'Event' AND column_name IN ('emailEntrantsOnResults', 'emailSubmissionReceipts') ORDER BY column_name`;
    expect(columns).toEqual([
      { column_name: "emailEntrantsOnResults", is_nullable: "NO", column_default: "false" },
      { column_name: "emailSubmissionReceipts", is_nullable: "NO", column_default: "false" },
    ]);
    // A row inserted the way pre-migration code wrote it (no mention of the columns) reads false.
    const id = `legacy-${randomUUID()}`;
    await prisma.$executeRaw`
      INSERT INTO "Event" ("id", "organisationId", "title", "slug", "startDateTime", "endDateTime", "timezone", "location", "description", "tags")
      VALUES (${id}, ${ids.organisation}, 'Legacy', ${`legacy-${suffix}`}, now(), now() + interval '1 hour', 'UTC', '', '', '{}')`;
    expect(await switchesOf(id)).toEqual(BOTH_OFF);
    const setup = await loadJudgingSetup(await organiser(event));
    expect(setup?.settings).toMatchObject({ emailEntrantsOnResults: false, emailSubmissionReceipts: false, resultsAnnouncedAt: null });
  });

  it("publishes with the results email off: nothing queued, nothing announced, sending now refused", async () => {
    const { event, ctx, addresses } = await readyToPublish();
    expect(await countResultsAnnouncementRecipients(ctx)).toBe(addresses.length);
    expect(await publishResults(ctx)).toMatchObject({ ok: true, data: { alreadyPublished: false, queued: 0, emailed: false } });
    expect(await prisma.outboxMessage.count({ where: announcementsFor(event.id) })).toBe(0);
    const row = await prisma.event.findUniqueOrThrow({ where: { id: event.id }, select: { resultsPublishedAt: true, resultsAnnouncedAt: true } });
    expect(row.resultsPublishedAt).not.toBeNull();
    expect(row.resultsAnnouncedAt).toBeNull();
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { action: "JUDGING_RESULTS_PUBLISHED", targetId: event.id } });
    expect(audit.metadata).toMatchObject({ recipients: 0, emailEntrantsOnResults: false });
    expect(await sendResultsAnnouncement(ctx)).toMatchObject({ ok: false });
    expect(await unpublishResults(ctx)).toMatchObject({ ok: true });
    expect(await publishResults(ctx)).toMatchObject({ ok: true, data: { queued: 0, emailed: false } });
    expect(await prisma.outboxMessage.count({ where: announcementsFor(event.id) })).toBe(0);
  });

  it("publishing with the switch on emails each confirmed entrant once, as before", async () => {
    const { event, ctx, addresses } = await readyToPublish({ emailEntrantsOnResults: true });
    expect(await publishResults(ctx)).toMatchObject({ ok: true, data: { queued: addresses.length, emailed: true } });
    expect(await announcedTo(event.id)).toEqual(addresses);
    expect(await sendResultsAnnouncement(ctx)).toMatchObject({ ok: true, data: { queued: 0, alreadyAnnounced: true } });
    expect(await prisma.outboxMessage.count({ where: announcementsFor(event.id) })).toBe(addresses.length);
  });

  it("turning the switch on later, send now emails each entrant once even when sent twice at the same time", async () => {
    const { event, ctx, addresses } = await readyToPublish();
    expect(await publishResults(ctx)).toMatchObject({ ok: true, data: { queued: 0 } });
    expect(await save(ctx, { emailEntrantsOnResults: true })).toMatchObject({ ok: true, data: { emailEntrantsOnResults: true, emailSubmissionReceipts: false } });
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { action: "JUDGING_SETTINGS_UPDATED", targetId: event.id }, orderBy: { createdAt: "desc" } });
    expect(audit.metadata).toMatchObject({ emailEntrantsOnResults: true, emailSubmissionReceipts: false, emailTogglesChanged: "emailEntrantsOnResults" });
    expect(await countResultsAnnouncementRecipients(ctx)).toBe(addresses.length);

    const both = await Promise.all([sendResultsAnnouncement(ctx), sendResultsAnnouncement(ctx)]);
    expect(queuedOf(both)).toEqual([0, addresses.length]);
    expect(both.filter((result) => result.ok && result.data.alreadyAnnounced)).toHaveLength(1);
    expect(await announcedTo(event.id)).toEqual(addresses);
    expect(await prisma.auditEvent.count({ where: { action: "JUDGING_RESULTS_ANNOUNCED", targetId: event.id } })).toBe(1);
    expect(await countResultsAnnouncementRecipients(ctx)).toBe(0);
    expect(await sendResultsAnnouncement(ctx)).toMatchObject({ ok: true, data: { queued: 0, alreadyAnnounced: true } });

    // The no-duplicate rules across unpublish/republish still hold: one copy delivered, the rest withdrawn.
    const delivered = (await prisma.outboxMessage.findMany({ where: announcementsFor(event.id) }))[0]!;
    await prisma.outboxMessage.update({ where: { id: delivered.id }, data: { status: "SENT", sentAt: new Date() } });
    expect(await unpublishResults(ctx)).toMatchObject({ ok: true });
    expect(await publishResults(ctx)).toMatchObject({ ok: true, data: { queued: addresses.length - 1, emailed: true } });
    expect(await announcedTo(event.id)).toEqual(addresses);
  });

  it("after a partly delivered announcement and a republish with the switch off, send now reaches only the withdrawn entrants", async () => {
    const { event, ctx, addresses } = await readyToPublish({ emailEntrantsOnResults: true });
    expect(await publishResults(ctx)).toMatchObject({ ok: true, data: { queued: addresses.length, emailed: true } });
    const delivered = (await prisma.outboxMessage.findMany({ where: announcementsFor(event.id), orderBy: { createdAt: "asc" } }))[0]!;
    await prisma.outboxMessage.update({ where: { id: delivered.id }, data: { status: "SENT", sentAt: new Date() } });
    expect(await unpublishResults(ctx)).toMatchObject({ ok: true });
    const kept = await prisma.event.findUniqueOrThrow({ where: { id: event.id }, select: { resultsAnnouncedAt: true } });
    expect(kept.resultsAnnouncedAt).not.toBeNull();
    expect(await announcedTo(event.id)).toEqual([(delivered.payload as { to: string }).to]);

    expect(await save(ctx, { emailEntrantsOnResults: false })).toMatchObject({ ok: true });
    expect(await publishResults(ctx)).toMatchObject({ ok: true, data: { queued: 0, emailed: false } });
    const off = (await loadJudgingSetup(ctx))!.settings;
    expect(off.resultsAnnouncedAt!.getTime()).toBe(kept.resultsAnnouncedAt!.getTime());
    expect(resultsAnnouncementState(off)).toBe("off");
    expect(announcedBefore(off)).toBe(true);
    expect(await sendResultsAnnouncement(ctx)).toMatchObject({ ok: false });

    expect(await save(ctx, { emailEntrantsOnResults: true })).toMatchObject({ ok: true });
    expect(resultsAnnouncementState((await loadJudgingSetup(ctx))!.settings)).toBe("ready");
    expect(await countResultsAnnouncementRecipients(ctx)).toBe(addresses.length - 1);
    const both = await Promise.all([sendResultsAnnouncement(ctx), sendResultsAnnouncement(ctx)]);
    expect(queuedOf(both)).toEqual([0, addresses.length - 1]);
    expect(await announcedTo(event.id)).toEqual(addresses);
    expect(resultsAnnouncementState((await loadJudgingSetup(ctx))!.settings)).toBe("announced");
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { action: "JUDGING_RESULTS_ANNOUNCED", targetId: event.id } });
    expect(audit.metadata).toMatchObject({ recipients: addresses.length - 1, announcedBefore: true });
  });

  it("after a fully delivered announcement, a republish with the switch off and send now emails nobody twice", async () => {
    const { event, ctx, addresses } = await readyToPublish({ emailEntrantsOnResults: true });
    expect(await publishResults(ctx)).toMatchObject({ ok: true, data: { queued: addresses.length } });
    await prisma.outboxMessage.updateMany({ where: announcementsFor(event.id), data: { status: "SENT", sentAt: new Date() } });
    expect(await unpublishResults(ctx)).toMatchObject({ ok: true });
    expect(await save(ctx, { emailEntrantsOnResults: false })).toMatchObject({ ok: true });
    expect(await publishResults(ctx)).toMatchObject({ ok: true, data: { queued: 0, emailed: false } });
    expect(await save(ctx, { emailEntrantsOnResults: true })).toMatchObject({ ok: true });
    expect(await countResultsAnnouncementRecipients(ctx)).toBe(0);
    expect(await sendResultsAnnouncement(ctx)).toMatchObject({ ok: true, data: { queued: 0, alreadyAnnounced: false } });
    expect(await prisma.outboxMessage.count({ where: announcementsFor(event.id) })).toBe(addresses.length);
  });

  it("queues the submission receipt only when receipts are on; registration, team and submission-link emails always go out", async () => {
    const event = await createEvent();
    const ctx = await organiser(event);
    expect((await save(ctx)).ok).toBe(true);
    const leader = await register(event, "receipt-leader", { mode: "create", name: `Receipts ${suffix.slice(0, 6)}` });
    const solo = await register(event, "receipt-solo");
    for (const rsvp of [leader, solo]) {
      expect(await prisma.outboxMessage.count({ where: { kind: "rsvp-confirmation", payload: { path: ["to"], equals: rsvp.guestEmail! } } })).toBe(1);
    }
    expect(await prisma.outboxMessage.count({ where: { kind: "team-created", payload: { path: ["teamId"], equals: leader.teamId! } } })).toBe(1);
    expect(await requestSubmissionLink({ rsvpId: solo.id, eventId: event.id })).toEqual({ ok: true, data: { sent: true } });
    expect(await prisma.outboxMessage.count({ where: { kind: "submission-link", payload: { path: ["rsvpId"], equals: solo.id } } })).toBe(1);

    const auth = await teamAuth(leader.teamId!);
    const submitted = await submitSubmission(auth, { title: "No receipt" });
    if (!submitted.ok) throw new Error(submitted.error);
    expect(submitted.data.receiptQueued).toBe(false);
    const receipts = () => prisma.outboxMessage.count({ where: { kind: "submission-received", payload: { path: ["submissionId"], equals: submitted.data.submissionId } } });
    expect(await receipts()).toBe(0);

    expect(await save(ctx, { emailSubmissionReceipts: true })).toMatchObject({ ok: true, data: { emailSubmissionReceipts: true, emailEntrantsOnResults: false } });
    expect(await withdrawSubmission(auth)).toMatchObject({ ok: true });
    expect(await submitSubmission(auth, { title: "With receipt" })).toMatchObject({ ok: true, data: { receiptQueued: true } });
    expect(await receipts()).toBe(1);
    // Editing a submitted project sends no second receipt.
    expect(await submitSubmission(auth, { title: "Edited" })).toMatchObject({ ok: true, data: { receiptQueued: false } });
    expect(await receipts()).toBe(1);
    // Settings saved without the switches (the Settings tab card) keep them.
    expect(await save(ctx)).toMatchObject({ ok: true, data: { emailSubmissionReceipts: true } });
  });

  it("refuses the switches and sending now to a co-organiser with every grant and to another organisation", async () => {
    const { event, ctx } = await readyToPublish();
    await prisma.eventCollaborator.create({ data: { eventId: event.id, userId: ids.coOrganiser, permissions: Object.values(EventPermission) } });
    const scope = { organisationSlug: orgSlug, eventId: event.id };
    const noPermission = { ok: false, error: "You do not have permission to manage judging for this event." };
    for (const userId of [ids.coOrganiser, ids.otherOrganiser]) {
      identity.id = userId;
      expect(await saveJudgingSettings({ ...scope, settings: { ...windowSettings(), emailEntrantsOnResults: true, emailSubmissionReceipts: true } })).toMatchObject(noPermission);
      expect(await publishJudgingResults(scope)).toMatchObject(noPermission);
      expect(await sendResultsAnnouncementAction(scope)).toMatchObject(noPermission);
      expect(await sendResultsAnnouncementAction({ organisationSlug: otherOrgSlug, eventId: event.id })).toMatchObject({ ok: false });
    }
    identity.id = "";
    expect(await switchesOf(event.id)).toEqual(BOTH_OFF);
    expect((await prisma.event.findUniqueOrThrow({ where: { id: event.id } })).resultsPublishedAt).toBeNull();

    // A forged context from another organisation finds no event.
    const foreign: JudgingOrganiserContext = { ...ctx, userId: ids.otherOrganiser, organisationId: ids.otherOrganisation, orgSlug: otherOrgSlug };
    expect(await sendResultsAnnouncement(foreign)).toMatchObject({ ok: false, error: "Event not found." });
    expect(await save(foreign, { emailEntrantsOnResults: true })).toMatchObject({ ok: false, error: "Event not found." });
    expect(await countResultsAnnouncementRecipients(foreign)).toBeNull();

    // The organiser can, through the same actions.
    identity.id = ids.organiser;
    expect(await publishJudgingResults(scope)).toMatchObject({ ok: true, data: { queued: 0, emailed: false } });
    expect(await saveJudgingSettings({ ...scope, settings: { ...windowSettings(), emailEntrantsOnResults: true } })).toMatchObject({ ok: true });
    expect(await sendResultsAnnouncementAction(scope)).toMatchObject({ ok: true, data: { queued: 3, alreadyAnnounced: false } });
    expect(await sendResultsAnnouncementAction(scope)).toMatchObject({ ok: true, data: { queued: 0, alreadyAnnounced: true } });
    identity.id = "";
    expect(await prisma.outboxMessage.count({ where: announcementsFor(event.id) })).toBe(3);
  });

  it("copies both switches when an event is cloned", async () => {
    const event = await createEvent();
    await prisma.event.update({ where: { id: event.id }, data: { emailEntrantsOnResults: true, emailSubmissionReceipts: true } });
    identity.id = ids.organiser;
    const cloned = await cloneEvent({ organisationSlug: orgSlug, eventId: event.id });
    identity.id = "";
    if (!cloned.ok || !cloned.data) throw new Error(cloned.ok ? "no data" : cloned.error);
    expect(await switchesOf(cloned.data.eventId)).toEqual({ emailEntrantsOnResults: true, emailSubmissionReceipts: true });
  });
});
