import { EventPermission, MembershipRole, RegistrationMode, RsvpStatus } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const identity = vi.hoisted(() => ({ id: "" }));
vi.mock("@/lib/auth", () => ({ auth: async () => (identity.id ? { user: { id: identity.id } } : null) }));
vi.mock("@/lib/actionRateLimit", () => ({ isActionRateLimited: async () => false }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/db";
import { submitRsvpCore } from "@/lib/rsvpCore";
import { flushWebhookEmits } from "@/lib/webhooks/emit";
import { cancelRsvp } from "@/app/actions/rsvp-cancel";
import { deleteRsvp, updateRsvpRegistration } from "@/app/actions/rsvp-admin";
import { approveRsvp, rejectRsvp } from "@/app/actions/rsvp-lifecycle";
import { checkSlugAvailability } from "@/app/actions/org";
import { updateEvent } from "@/app/actions/event";
import { addTeamMemberByLeader, joinTeamWithExistingRsvp, organiserMoveMember, resolveOrganiserEvent } from "@/lib/core/teams";
import { resolveEntrantForUser } from "@/lib/core/judging";
import { listUnsubmittedEntrants } from "@/lib/core/judgingEntrants";
import { ticketDesignFor } from "@/lib/ticketDesign/resolve";
import { loadAccountRegistrations } from "@/lib/accountRegistrations";
import { CREW_EMAIL_REFUSED } from "@/lib/core/crew";
import { addCrew, createCrewEvent, crew, crewEmail, register, setUpCrewOrgs, tearDownCrewOrgs } from "./helpers/crew";

/* What the guest, team, project and account flows refuse or show for crew tickets (docs/CREW.md). */

describe.sequential("crew guards", () => {
  beforeAll(() => setUpCrewOrgs("guards"));
  afterAll(async () => {
    identity.id = "";
    await flushWebhookEmits();
    await tearDownCrewOrgs();
  });

  it("keeps crew tickets out of self-cancel and the Guests · People edit, remove and lifecycle actions", async () => {
    const event = await createCrewEvent();
    const member = await addCrew(event);
    const target = { organisationSlug: crew.orgSlug, eventId: event.id, rsvpId: member.rsvpId };
    identity.id = "";
    await expect(cancelRsvp({ checkInToken: member.rsvp.checkInToken })).resolves.toMatchObject({ ok: false, error: expect.stringContaining("crew") });
    identity.id = crew.organiserId;
    await expect(deleteRsvp(target)).resolves.toMatchObject({ ok: false, error: expect.stringContaining("Guests → Crew") });
    await expect(updateRsvpRegistration({ ...target, name: "Edited", answers: {} })).resolves.toMatchObject({ ok: false, error: expect.stringContaining("Guests → Crew") });
    await expect(approveRsvp(target)).resolves.toMatchObject({ ok: false, error: expect.stringContaining("Guests → Crew") });
    await expect(rejectRsvp(target)).resolves.toMatchObject({ ok: false, error: expect.stringContaining("Guests → Crew") });
    await expect(prisma.rSVP.findUniqueOrThrow({ where: { id: member.rsvpId } })).resolves.toMatchObject({ status: RsvpStatus.CONFIRMED, isCrew: true, guestName: member.name });
  });

  it("refuses a registration or a guest-email change to an email already on the crew", async () => {
    const event = await createCrewEvent();
    const member = await addCrew(event);
    const again = await submitRsvpCore({ orgSlug: crew.orgSlug, eventSlug: event.slug, guestEmail: member.email.toUpperCase(), name: "Again", answers: {} }, { userId: null });
    expect(again).toEqual({ ok: false, error: CREW_EMAIL_REFUSED });
    const user = await prisma.user.create({ data: { name: "Account crew", email: member.email } });
    try {
      await expect(submitRsvpCore({ orgSlug: crew.orgSlug, eventSlug: event.slug, name: "Account crew", answers: {} }, { userId: user.id })).resolves.toEqual({ ok: false, error: CREW_EMAIL_REFUSED });
    } finally {
      await prisma.user.delete({ where: { id: user.id } });
    }
    const guest = await register(event, "guest");
    identity.id = crew.organiserId;
    await expect(updateRsvpRegistration({ organisationSlug: crew.orgSlug, eventId: event.id, rsvpId: guest.rsvp.id, guestEmail: member.email, answers: {} })).resolves.toEqual({ ok: false, error: CREW_EMAIL_REFUSED });
    await expect(prisma.rSVP.count({ where: { eventId: event.id } })).resolves.toBe(2);
  });

  it("keeps crew tickets out of teams: no joining by link and no organiser move", async () => {
    const event = await createCrewEvent({ registrationMode: RegistrationMode.TEAM });
    const leader = await register(event, "leader", { mode: "create", name: `Team ${crew.suffix}` });
    const team = await prisma.team.findUniqueOrThrow({ where: { id: leader.rsvp.teamId! } });
    const member = await addCrew(event);
    const holder = { rsvpId: member.rsvp.id, eventId: event.id, organisationId: crew.organisationId, userId: null, teamId: null };
    expect((await joinTeamWithExistingRsvp(holder, team.joinToken)).ok).toBe(false);
    const ctx = { userId: crew.organiserId, organisationId: crew.organisationId, orgSlug: crew.orgSlug, eventId: event.id, eventSlug: event.slug };
    expect((await organiserMoveMember(ctx, { rsvpId: member.rsvp.id, targetTeamId: team.id })).ok).toBe(false);
    await expect(prisma.rSVP.findUniqueOrThrow({ where: { id: member.rsvp.id } })).resolves.toMatchObject({ teamId: null, isCrew: true });
  });

  it("refuses a team leader adding a crew member's email to their team", async () => {
    const event = await createCrewEvent({ registrationMode: RegistrationMode.TEAM });
    const leaderUser = await prisma.user.create({ data: { name: "Leader", email: crewEmail("leader-account") } });
    try {
      const registered = await submitRsvpCore({ orgSlug: crew.orgSlug, eventSlug: event.slug, name: "Leader", answers: {} }, { userId: leaderUser.id, team: { mode: "create", name: `Herons ${crew.suffix}` } });
      expect(registered.ok).toBe(true);
      const leaderRsvp = await prisma.rSVP.findFirstOrThrow({ where: { eventId: event.id, userId: leaderUser.id } });
      const member = await addCrew(event);
      const auth = { kind: "user" as const, teamId: leaderRsvp.teamId!, eventId: event.id, userId: leaderUser.id };
      await expect(addTeamMemberByLeader(auth, { name: "Crew", email: member.email.toUpperCase() })).resolves.toEqual({ ok: false, error: CREW_EMAIL_REFUSED });
      await expect(prisma.rSVP.count({ where: { teamId: leaderRsvp.teamId } })).resolves.toBe(1);
    } finally {
      await prisma.rSVP.deleteMany({ where: { userId: leaderUser.id } });
      await prisma.user.delete({ where: { id: leaderUser.id } });
    }
  });

  it("never treats crew as hackathon entrants", async () => {
    const event = await createCrewEvent();
    await prisma.event.update({ where: { id: event.id }, data: { submissionsEnabled: true } });
    const user = await prisma.user.create({ data: { name: "Account crew", email: crewEmail("account-crew") } });
    try {
      const result = await submitRsvpCore({ orgSlug: crew.orgSlug, eventSlug: event.slug, name: "Account crew", answers: {} }, { userId: user.id });
      expect(result.ok).toBe(true);
      expect(await resolveEntrantForUser(user.id, event.id)).not.toBeNull();
      await addCrew(event, { email: user.email });
      expect(await resolveEntrantForUser(user.id, event.id)).toBeNull();
      const attendee = await register(event, "entrant");
      const ctx = { userId: crew.organiserId, organisationId: crew.organisationId, orgSlug: crew.orgSlug, eventId: event.id, eventSlug: event.slug };
      const ids = (await listUnsubmittedEntrants(ctx)).entrants.map((entrant) => entrant.id);
      expect(ids).toContain(attendee.rsvp.id);
      const crewRsvp = await prisma.rSVP.findFirstOrThrow({ where: { eventId: event.id, userId: user.id } });
      expect(ids).not.toContain(crewRsvp.id);

      // Account → Registrations: worded as crew, no cancel, no project link.
      const rows = await loadAccountRegistrations(user.id);
      expect(rows.upcoming.find((row) => row.id === crewRsvp.id)).toMatchObject({ status: { label: "Crew" }, cancelToken: null, submissionHref: null });
    } finally {
      await prisma.rSVP.deleteMany({ where: { userId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  it("prints Crew and no price on a designed ticket", async () => {
    const event = await createCrewEvent();
    const member = await addCrew(event);
    await expect(ticketDesignFor(member.rsvp.checkInToken)).resolves.toMatchObject({ values: { ticket: "Crew", price: "", name: member.name } });
  });

  it("lets only owners, admins and MANAGE_REGISTRATIONS co-organisers manage the crew; being crew grants nothing", async () => {
    const event = await createCrewEvent();
    const [member, checkIn, registrations, crewUser] = await Promise.all(
      ["member", "check-in", "registrations", "crew-user"].map((label) => prisma.user.create({ data: { name: label, email: crewEmail(label) } })),
    );
    try {
      await prisma.membership.createMany({ data: [member, checkIn, registrations].map((user) => ({ userId: user!.id, organisationId: crew.organisationId, role: MembershipRole.MEMBER })) });
      await prisma.eventCollaborator.createMany({ data: [
        { eventId: event.id, userId: checkIn!.id, permissions: [EventPermission.CHECK_IN] },
        { eventId: event.id, userId: registrations!.id, permissions: [EventPermission.MANAGE_REGISTRATIONS] },
      ] });
      await addCrew(event, { email: crewUser!.email });
      expect(await resolveOrganiserEvent(crew.organiserId, crew.orgSlug, event.id)).not.toBeNull();
      expect(await resolveOrganiserEvent(registrations!.id, crew.orgSlug, event.id)).not.toBeNull();
      expect(await resolveOrganiserEvent(checkIn!.id, crew.orgSlug, event.id)).toBeNull();
      expect(await resolveOrganiserEvent(member!.id, crew.orgSlug, event.id)).toBeNull();
      expect(await resolveOrganiserEvent(crewUser!.id, crew.orgSlug, event.id)).toBeNull();
      expect(await resolveOrganiserEvent(crew.otherOrganiserId, crew.orgSlug, event.id)).toBeNull();
    } finally {
      await prisma.user.deleteMany({ where: { id: { in: [member, checkIn, registrations, crewUser].map((user) => user!.id) } } });
    }
  });

  it("lets an event with only crew switch registration mode, but not once someone registered", async () => {
    const event = await createCrewEvent();
    await addCrew(event);
    identity.id = crew.organiserId;
    const input = (mode: RegistrationMode) => ({
      organisationSlug: crew.orgSlug, eventId: event.id, title: event.title, tags: "", coverImageUrl: "",
      startDateTime: event.startDateTime.toISOString(), endDateTime: event.endDateTime.toISOString(), timezone: "UTC",
      location: "Main hall", mapLinkUrl: "", isOnline: false, capacity: "", registrationClosesAt: "", registrationLeadMinutes: "",
      status: event.status, privacyType: event.privacyType, listedPublicly: false,
      registrationMode: mode, ...(mode === RegistrationMode.TEAM ? { teamMinSize: 2, teamMaxSize: 4, soloPolicy: "SOLO_ALLOWED" } : {}),
    });
    await expect(updateEvent(input(RegistrationMode.TEAM))).resolves.toEqual({ ok: true });
    await expect(prisma.event.findUniqueOrThrow({ where: { id: event.id } })).resolves.toMatchObject({ registrationMode: RegistrationMode.TEAM });
    await register(event, "solo");
    await expect(updateEvent(input(RegistrationMode.INDIVIDUAL))).resolves.toMatchObject({ ok: false });
  });

  it("reserves the crew organisation slug for the sign-up route", async () => {
    expect(await checkSlugAvailability("crew")).toMatchObject({ available: false });
    expect(await checkSlugAvailability("CREW")).toMatchObject({ available: false });
  });
});
