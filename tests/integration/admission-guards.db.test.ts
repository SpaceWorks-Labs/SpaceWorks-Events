import { AdmissionStatus, RsvpStatus } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const identity = vi.hoisted(() => ({ id: "" }));
vi.mock("@/lib/auth", () => ({ auth: async () => (identity.id ? { user: { id: identity.id } } : null) }));
vi.mock("@/lib/actionRateLimit", () => ({ isActionRateLimited: async () => false }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/frontend/revalidation", () => ({ trackedRevalidation: (fn: unknown) => fn }));

import { prisma } from "@/lib/db";
import { approveRsvp, promoteFromWaitlist, reacceptRsvp, rejectRsvp } from "@/app/actions/rsvp-lifecycle";
import { approveTeam } from "@/app/actions/team-admin";
import { resolveAdmissionOrganiser } from "@/lib/admission/access";
import { draftDecisions } from "@/lib/admission/decisions";
import { HAS_REGISTRATIONS_REFUSAL, setAdmissionEnabled } from "@/lib/admission/settings";
import { offerNextWaitlisted } from "@/lib/payments/operations";
import { appOf, apply, createAdmissionEvent, decide, organiserCtx, paid, people, setUpAdmission, tearDownAdmission } from "./helpers/admission";

/*
 * Guards (docs/ADMISSION.md "Guards"): crew never become applications; the
 * older approve, decline, promote, re-accept and waitlist-offer paths are
 * refused for applications; applications stay in their organisation; and
 * applications are turned on or off only before anyone registers.
 */

beforeAll(() => setUpAdmission("Application guards"));
afterAll(() => tearDownAdmission());

const as = async <T>(userId: string, run: () => Promise<T>) => {
  identity.id = userId;
  try { return await run(); } finally { identity.id = ""; }
};

describe.sequential("admission guards", () => {
  it("never makes a crew ticket an application, nor counts it among offers", async () => {
    const { event, ctx } = await createAdmissionEvent({ offerCapacity: 1 });
    const crew = await prisma.rSVP.create({ data: { eventId: event.id, guestEmail: `crew-${paid.suffix}@example.test`, guestName: "Crew", attendeeKey: `guest:crew-${paid.suffix}@example.test`, status: RsvpStatus.CONFIRMED, isCrew: true } });
    expect(await prisma.admissionApplication.count({ where: { rsvpId: crew.id } })).toBe(0);
    await expect(prisma.admissionApplication.create({ data: { eventId: event.id, rsvpId: crew.id } })).rejects.toThrow(/crew ticket/);
    const a = await apply(event, "after-crew");
    // The one offer is still free: crew hold none.
    await decide(ctx, [a.application.id], "ACCEPT");
    expect(await appOf(a.application.id)).toMatchObject({ status: AdmissionStatus.OFFERED });
  });

  it("refuses the guest list's approve, decline, promote and re-accept for applications", async () => {
    const { event, ctx } = await createAdmissionEvent({ capacity: 5 });
    const a = await apply(event, "listed");
    const base = { organisationSlug: paid.orgSlug, rsvpId: a.rsvp.id, eventId: event.id };
    for (const action of [approveRsvp, rejectRsvp, promoteFromWaitlist]) {
      expect(await as(people.owner, () => action(base))).toMatchObject({ ok: false, error: expect.stringContaining("Applications tab") });
    }
    expect(await as(people.owner, () => reacceptRsvp(base))).toMatchObject({ ok: false, error: expect.stringContaining("Applications tab") });
    await decide(ctx, [a.application.id], "WAITLIST");
    expect(await offerNextWaitlisted({ eventId: event.id })).toBe(false);
    expect((await prisma.rSVP.findUniqueOrThrow({ where: { id: a.rsvp.id } })).status).toBe(RsvpStatus.WAITLISTED);

    const team = await createAdmissionEvent({ team: true });
    const leader = await apply(team.event, "team-lead", { team: { mode: "create", name: `Guarded ${paid.suffix.slice(0, 6)}` } });
    expect(await as(people.owner, () => approveTeam({ organisationSlug: paid.orgSlug, eventId: team.event.id, teamId: leader.rsvp.teamId }))).toMatchObject({ ok: false, error: expect.stringContaining("Applications tab") });
  });

  it("keeps applications inside their organisation and event", async () => {
    const { event, ctx } = await createAdmissionEvent();
    const a = await apply(event, "tenant");
    const other = await prisma.organisation.create({ data: { name: "Other", slug: `other-${paid.suffix}` } });
    try {
      await prisma.membership.create({ data: { userId: people.outsider, organisationId: other.id, role: "OWNER" } });
      expect(await resolveAdmissionOrganiser(people.outsider, paid.orgSlug, event.id)).toBeNull();
      expect(await resolveAdmissionOrganiser(people.outsider, other.slug, event.id)).toBeNull();
      expect(await resolveAdmissionOrganiser(people.owner, paid.orgSlug, event.id)).toMatchObject({ eventId: event.id, isAdmin: true });
      // An application of another event can't be decided through this one.
      const second = await createAdmissionEvent();
      expect(await draftDecisions(second.ctx, { applicationIds: [a.application.id], outcome: "REJECT", overrideReason: "x" })).toMatchObject({ ok: false });
      expect(await draftDecisions({ ...ctx, organisationId: other.id }, { applicationIds: [a.application.id], outcome: "REJECT", overrideReason: "x" })).toMatchObject({ ok: false });
    } finally {
      await prisma.organisation.delete({ where: { id: other.id } });
    }
  });

  it("turns applications on or off only before anyone registers", async () => {
    const { event, ctx } = await createAdmissionEvent();
    await apply(event, "early");
    expect(await setAdmissionEnabled(ctx, false)).toEqual({ ok: false, error: HAS_REGISTRATIONS_REFUSAL });
    expect(await setAdmissionEnabled({ ...organiserCtx(event, people.r1), isAdmin: false }, false)).toMatchObject({ ok: false });
    await expect(prisma.event.update({ where: { id: event.id }, data: { privacyType: "PUBLIC" } })).rejects.toThrow(/Event_admission_shape/);
  });
});
