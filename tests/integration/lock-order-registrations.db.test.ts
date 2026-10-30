import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const identity = vi.hoisted(() => ({ id: "" }));
vi.mock("@/lib/auth", () => ({ auth: async () => (identity.id ? { user: { id: identity.id } } : null) }));
vi.mock("@/lib/reauth", () => ({ hasRecentAuthentication: async () => true }));
vi.mock("@/lib/actionRateLimit", () => ({ isActionRateLimited: async () => false }));
vi.mock("@/lib/outboxWorker", () => ({ startOutboxWorker: () => {} }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/db";
import { revokeAllSessions } from "@/app/actions/security";
import { commitListCheckIn, commitUndoListCheckIn } from "@/lib/checkInListMutations";
import { removeCrewMember, updateCrewMemberAsOrganiser } from "@/lib/core/crew";
import { deviceHash } from "@/lib/loginSecurity";
import { issueMobileSession, markMobileSessionMfaVerified, refreshMobileSession, requireMobileUser, revokeMobileSession } from "@/lib/mobileAuth";
import { cancelRegistrationByToken } from "@/lib/rsvpCancel";
import { flushWebhookEmits } from "@/lib/webhooks/emit";
import { addCrew, createCrewEvent, crew, crewEmail, ctxFor, register, setUpCrewOrgs, tearDownCrewOrgs } from "./helpers/crew";
import { fulfilled, holdLocks, raceBehind } from "./helpers/locks";

/*
 * Lock order for account sessions (docs/MOBILE_API.md), custom check-in lists
 * (docs/CHECK_IN.md) and crew (docs/CREW.md): parent before child, so each
 * pair below queues on one row instead of deadlocking. Each case holds the
 * first lock of both commands and releases them together (helpers/locks.ts).
 */
describe.sequential("registration and session lock order", () => {
  beforeAll(() => setUpCrewOrgs("locks"));
  afterAll(async () => {
    await flushWebhookEmits();
    await tearDownCrewOrgs();
  });

  const device = deviceHash("e".repeat(64))!;
  const otherDevice = deviceHash("f".repeat(64))!;

  async function phoneUser() {
    const user = await prisma.user.create({ data: { name: "Locks phone", email: crewEmail("phone"), emailVerified: new Date() } });
    const issued = await issueMobileSession({ userId: user.id, verifiedSessionVersion: user.sessionVersion, deviceHash: device, platform: "android", method: "password", mfaVerified: false });
    if (!issued) throw new Error("not issued");
    return { user, issued, actor: (await requireMobileUser(new Request("https://api.example.test/", { headers: { authorization: `Bearer ${issued.accessToken}` } })))! };
  }

  it("signs out, verifies MFA or revokes a replayed token on a phone alongside signing out everywhere", async () => {
    const cases = {
      logout: (s: Awaited<ReturnType<typeof phoneUser>>) => revokeMobileSession(s.actor),
      mfa: (s: Awaited<ReturnType<typeof phoneUser>>) => markMobileSessionMfaVerified(s.actor),
      // The current refresh token presented from another install revokes the session.
      replay: (s: Awaited<ReturnType<typeof phoneUser>>) => refreshMobileSession(s.issued.refreshToken, otherDevice),
    };
    for (const [name, run] of Object.entries(cases)) {
      const phone = await phoneUser();
      identity.id = phone.user.id;
      try {
        const [everywhere, single] = await raceBehind(
          await holdLocks(async (tx) => {
            await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${phone.user.id} FOR UPDATE`;
            await tx.$queryRaw`SELECT "id" FROM "MobileSession" WHERE "id" = ${phone.issued.sessionId} FOR UPDATE`;
          }),
          () => revokeAllSessions(),
          () => run(phone),
        );
        expect(fulfilled(everywhere), name).toEqual({ ok: true });
        fulfilled(single);
      } finally {
        identity.id = "";
      }
      expect((await prisma.mobileSession.findUniqueOrThrow({ where: { id: phone.issued.sessionId } })).revokedAt, name).toBeInstanceOf(Date);
      await prisma.auditEvent.deleteMany({ where: { actorUserId: phone.user.id } });
      await prisma.user.delete({ where: { id: phone.user.id } });
    }
  });

  it("undoes a custom-list check-in alongside the guest cancelling their registration", async () => {
    const event = await createCrewEvent();
    const { rsvp } = await register(event, "lister");
    const list = await prisma.checkInList.create({ data: { eventId: event.id, name: "Lunch" } });
    expect(await commitListCheckIn({ listId: list.id, rsvpId: rsvp.id, actorUserId: crew.organiserId, source: "online", checkedInAt: new Date(), force: false })).toMatchObject({ state: "checked-in" });
    const [cancelled, undone] = await raceBehind(
      await holdLocks(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "RSVP" WHERE "id" = ${rsvp.id} FOR UPDATE`;
        await tx.$queryRaw`SELECT "id" FROM "CheckInListRecord" WHERE "listId" = ${list.id} AND "rsvpId" = ${rsvp.id} FOR UPDATE`;
      }),
      () => cancelRegistrationByToken(null, rsvp.checkInToken, { revalidate: false }),
      () => commitUndoListCheckIn({ listId: list.id, rsvpId: rsvp.id, actorUserId: crew.organiserId, source: "online" }),
    );
    expect(fulfilled(cancelled)).toMatchObject({ ok: true });
    // The cancellation queued first, so the record went with the registration.
    expect(fulfilled(undone)).toBe("not-checked-in");
    expect(await prisma.rSVP.count({ where: { id: rsvp.id } })).toBe(0);
  });

  it("edits a guest crew member alongside their removal", async () => {
    const event = await createCrewEvent();
    const member = await addCrew(event, { name: "Edited Person" });
    const [removed, edited] = await raceBehind(
      await holdLocks(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "RSVP" WHERE "id" = ${member.rsvpId} FOR UPDATE`;
        await tx.$queryRaw`SELECT "id" FROM "EventCrewMember" WHERE "id" = ${member.id} FOR UPDATE`;
      }),
      () => removeCrewMember(ctxFor(event), member.id),
      () => updateCrewMemberAsOrganiser(ctxFor(event), member.id, { name: "Renamed Person", email: member.email, foodPreference: "", role: "Logistics" }),
    );
    expect(fulfilled(removed)).toMatchObject({ ok: true });
    expect(fulfilled(edited)).toEqual({ ok: false, error: "Crew member not found." });
    expect(await prisma.eventCrewMember.count({ where: { id: member.id } })).toBe(0);
  });
});
