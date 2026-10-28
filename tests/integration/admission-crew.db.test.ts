import { AdmissionStatus, RsvpStatus } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: async () => null }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/db";

import { addCrewMemberAsOrganiser } from "@/lib/core/crew";
import { respondAsApplicant } from "@/lib/admission/respond";
import { flushWebhookEmits } from "@/lib/webhooks/emit";
import { appOf, apply, createAdmissionEvent, decide, people, rsvpOf, setUpAdmission, tearDownAdmission } from "./helpers/admission";

/*
 * Adding an applicant to the crew (docs/CREW.md#applicants): the application
 * is detached and kept; an open one only with the organiser's confirmation,
 * then WITHDRAWN and its offer re-offered; a closed one as it is, so a
 * rejected applicant can still volunteer. Never a database error.
 */

beforeAll(() => setUpAdmission("Applicants on the crew"));
afterAll(async () => {
  await flushWebhookEmits();
  await tearDownAdmission();
});

type Applicant = Awaited<ReturnType<typeof apply>>;
type Setup = Awaited<ReturnType<typeof createAdmissionEvent>>;

const crewCtx = ({ event }: Setup) => ({ organisationId: event.organisationId, eventId: event.id, actorUserId: people.owner });
const addAsCrew = (setup: Setup, who: Applicant, withdrawApplication?: boolean) =>
  addCrewMemberAsOrganiser(crewCtx(setup), { name: "Crew Person", email: who.email, ...(withdrawApplication === undefined ? {} : { withdrawApplication }) });

async function expectCrewTicket(who: Applicant, applicationStatus: AdmissionStatus) {
  const rsvp = await rsvpOf(who.rsvp.id);
  expect(rsvp).toMatchObject({ isCrew: true, status: RsvpStatus.CONFIRMED, checkInToken: who.token });
  // Detached and kept as history.
  expect(await appOf(who.application.id)).toMatchObject({ rsvpId: null, status: applicationStatus });
  expect(await prisma.admissionApplication.count({ where: { rsvpId: who.rsvp.id } })).toBe(0);
}

describe.sequential("admission applicants on the crew", () => {
  it("withdraws an application in review or on the waitlist only once the organiser confirms", async () => {
    const setup = await createAdmissionEvent();
    const reviewing = await apply(setup.event, "reviewing");
    const waiting = await apply(setup.event, "waiting");
    await decide(setup.ctx, [waiting.application.id], "WAITLIST");

    // The waitlisted one first: withdrawing either runs promotion, which would offer it a place.
    for (const [who, status, words] of [[waiting, AdmissionStatus.WAITLISTED, "waitlist"], [reviewing, AdmissionStatus.IN_REVIEW, "still in review"]] as const) {

      // Unconfirmed: refused with the warning, nothing changes.
      expect(await addAsCrew(setup, who)).toMatchObject({ ok: false, code: "ADMISSION_MANAGED", error: expect.stringContaining(words) });
      expect(await addAsCrew(setup, who, false)).toMatchObject({ ok: false, code: "ADMISSION_MANAGED" });
      expect(await appOf(who.application.id)).toMatchObject({ rsvpId: who.rsvp.id, status });
      expect((await rsvpOf(who.rsvp.id)).isCrew).toBe(false);
      expect(await prisma.eventCrewMember.count({ where: { rsvpId: who.rsvp.id } })).toBe(0);

      expect(await addAsCrew(setup, who, true)).toMatchObject({ ok: true });
      await expectCrewTicket(who, AdmissionStatus.WITHDRAWN);
    }
    expect(await prisma.admissionStatusEvent.count({ where: { applicationId: waiting.application.id, status: AdmissionStatus.WITHDRAWN } })).toBe(1);
  });

  it("withdraws an offered applicant (never accepting the offer) and re-offers the freed place", async () => {
    const setup = await createAdmissionEvent({ offerCapacity: 1 });
    const offered = await apply(setup.event, "offered");
    const next = await apply(setup.event, "next");
    await decide(setup.ctx, [offered.application.id], "ACCEPT");
    await decide(setup.ctx, [next.application.id], "WAITLIST");
    expect(await appOf(offered.application.id)).toMatchObject({ status: AdmissionStatus.OFFERED });

    expect(await addAsCrew(setup, offered)).toMatchObject({ ok: false, code: "ADMISSION_MANAGED", error: expect.stringContaining("offered a place") });
    expect(await addAsCrew(setup, offered, true)).toMatchObject({ ok: true });
    await expectCrewTicket(offered, AdmissionStatus.WITHDRAWN);
    // The offer it held went to the waitlist.
    expect(await appOf(next.application.id)).toMatchObject({ status: AdmissionStatus.OFFERED });
    // The crew ticket's token answers no application.
    expect(await respondAsApplicant(offered.token, "accept")).toMatchObject({ ok: false });
  });

  it("withdraws an accepted applicant and frees their place for the waitlist", async () => {
    const setup = await createAdmissionEvent({ offerCapacity: 1 });
    const accepted = await apply(setup.event, "accepted");
    const next = await apply(setup.event, "queued");
    await decide(setup.ctx, [accepted.application.id], "ACCEPT");
    expect(await respondAsApplicant(accepted.token, "accept")).toMatchObject({ ok: true, status: AdmissionStatus.ACCEPTED });
    await decide(setup.ctx, [next.application.id], "WAITLIST");

    expect(await addAsCrew(setup, accepted)).toMatchObject({ ok: false, code: "ADMISSION_MANAGED", error: expect.stringContaining("accepted a place") });
    expect((await rsvpOf(accepted.rsvp.id)).isCrew).toBe(false);
    expect(await addAsCrew(setup, accepted, true)).toMatchObject({ ok: true });
    await expectCrewTicket(accepted, AdmissionStatus.WITHDRAWN);
    expect(await appOf(next.application.id)).toMatchObject({ status: AdmissionStatus.OFFERED });
  });

  it("adds a rejected, declined or expired applicant without asking, keeping their closed application", async () => {
    const setup = await createAdmissionEvent();
    const rejected = await apply(setup.event, "rejected");
    const declined = await apply(setup.event, "declined");
    const expired = await apply(setup.event, "expired");
    await decide(setup.ctx, [rejected.application.id], "REJECT");
    await decide(setup.ctx, [declined.application.id, expired.application.id], "ACCEPT");
    expect(await respondAsApplicant(declined.token, "decline")).toMatchObject({ ok: true, status: AdmissionStatus.DECLINED });
    // An expired offer (as the beat would leave it).
    await prisma.$transaction([
      prisma.admissionApplication.update({ where: { id: expired.application.id }, data: { status: AdmissionStatus.EXPIRED, version: { increment: 1 } } }),
      prisma.rSVP.update({ where: { id: expired.rsvp.id }, data: { status: RsvpStatus.REJECTED } }),
    ]);

    for (const [who, status] of [[rejected, AdmissionStatus.REJECTED], [declined, AdmissionStatus.DECLINED], [expired, AdmissionStatus.EXPIRED]] as const) {
      expect(await addAsCrew(setup, who)).toMatchObject({ ok: true });
      await expectCrewTicket(who, status);
    }
  });

  it("refuses at the database a registration becoming crew while an application is attached", async () => {
    const setup = await createAdmissionEvent();
    const a = await apply(setup.event, "raw");
    await expect(prisma.rSVP.update({ where: { id: a.rsvp.id }, data: { isCrew: true } })).rejects.toThrow(/admission_crew_application/);
    expect(await appOf(a.application.id)).toMatchObject({ rsvpId: a.rsvp.id, status: AdmissionStatus.IN_REVIEW });
  });
});
