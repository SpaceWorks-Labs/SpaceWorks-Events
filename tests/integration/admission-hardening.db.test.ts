import { AdmissionStatus, RsvpStatus } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn().mockResolvedValue(null) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/db";
import { loadAccountApplications } from "@/lib/admission/accountExport";
import { editApplicationAnswers } from "@/lib/admission/answers";
import { admissionJoinRefusal, admissionKeyHash, admissionRegistrationRefusal, ALREADY_APPLIED, OWN_APPLICATION_CLOSED } from "@/lib/admission/registration";
import { respondAsApplicant } from "@/lib/admission/respond";
import { REENABLE_REFUSAL, setAdmissionEnabled } from "@/lib/admission/settings";
import { drainApplicationEvents } from "@/lib/admission/statusEvents";
import { AdmissionManagedError } from "@/lib/payments/operations";
import { transferTicket } from "@/lib/payments/transfers";
import { appOf, apply, createAdmissionEvent, decide, paid, setUpAdmission, tearDownAdmission } from "./helpers/admission";

/*
 * Applications hardening (docs/ADMISSION.md "Retention", "One application
 * per person"): leaving or losing a decided team declines the place, a
 * reviewed solo application can't move into a team, transfers are refused,
 * guest and account keys are one person, webhooks carry the stage at the
 * change, a deleted account is scrubbed but still blocks re-applying, and
 * applications can't be turned on again once an event had them.
 */

beforeAll(() => setUpAdmission("Application hardening"));
afterAll(() => tearDownAdmission());

describe.sequential("application hardening", () => {
  it("declines the members of a deleted decided team, and lets a member of a team in review apply alone", async () => {
    const { event, ctx } = await createAdmissionEvent({ team: true });
    const leader = await apply(event, "lead", { team: { mode: "create", name: `Gone ${paid.suffix.slice(0, 6)}` } });
    const team = await prisma.team.findUniqueOrThrow({ where: { id: leader.rsvp.teamId! } });
    const member = await apply(event, "member", { team: { mode: "join", joinToken: team.joinToken } });
    // A member leaving while the team is in review applies on their own.
    await prisma.rSVP.update({ where: { id: member.rsvp.id }, data: { teamId: null } });
    const solo = await prisma.admissionApplication.findUniqueOrThrow({ where: { rsvpId: member.rsvp.id } });
    expect(solo.status).toBe(AdmissionStatus.IN_REVIEW);
    expect((await appOf(leader.application.id)).applicantKeys).not.toContain(admissionKeyHash(member.rsvp.attendeeKey));

    const second = await apply(event, "second", { team: { mode: "join", joinToken: team.joinToken } });
    await decide(ctx, [leader.application.id], "ACCEPT");
    await prisma.team.delete({ where: { id: team.id } });
    expect(await appOf(leader.application.id)).toMatchObject({ status: AdmissionStatus.WITHDRAWN, teamId: null });
    expect(await prisma.rSVP.findUniqueOrThrow({ where: { id: second.rsvp.id } })).toMatchObject({ status: RsvpStatus.REJECTED, teamId: null });
    expect(await prisma.admissionApplication.count({ where: { rsvpId: second.rsvp.id } })).toBe(0);
  });

  it("keeps a reviewed solo application out of teams", async () => {
    const { event } = await createAdmissionEvent({ team: true });
    await prisma.eventRegistrationForm.create({ data: { eventId: event.id, fields: { create: [{ key: "why", label: "Why?", type: "TEXT" }] } } });
    const leader = await apply(event, "lead", { team: { mode: "create", name: `Touch ${paid.suffix.slice(0, 6)}` } });
    const solo = await apply(event, "touched");
    expect(await editApplicationAnswers(solo.token, { why: "Changed" })).toEqual({ ok: true });
    expect(await admissionJoinRefusal(prisma, { teamId: leader.rsvp.teamId!, rsvpId: solo.rsvp.id })).toBe(OWN_APPLICATION_CLOSED);
    await expect(prisma.rSVP.update({ where: { id: solo.rsvp.id }, data: { teamId: leader.rsvp.teamId } })).rejects.toThrow(/admission_team_closed/);
  });

  it("refuses ticket transfers on events taking applications", async () => {
    const { event, ctx } = await createAdmissionEvent();
    const free = await prisma.ticketType.create({ data: { eventId: event.id, name: "Free", priceMinor: BigInt(0), maxPerOrder: 1 } });
    await prisma.event.update({ where: { id: event.id }, data: { allowTransfers: true } });
    const a = await apply(event, "holder", { ticketTypeId: free.id });
    await decide(ctx, [a.application.id], "ACCEPT");
    expect(await respondAsApplicant(a.token, "accept")).toMatchObject({ ok: true, status: AdmissionStatus.ACCEPTED });
    const order = await prisma.order.findFirstOrThrow({ where: { eventId: event.id } });
    await expect(transferTicket({ orderToken: order.accessToken, rsvpId: a.rsvp.id, name: "Someone Else", email: `else-${paid.suffix}@example.test` })).rejects.toBeInstanceOf(AdmissionManagedError);
  });

  it("treats a guest email and an account with that verified email as one person, and scrubs a deleted account", async () => {
    const { event } = await createAdmissionEvent();
    await prisma.eventRegistrationForm.create({ data: { eventId: event.id, fields: { create: [{ key: "why", label: "Why?", type: "TEXT" }] } } });
    const user = await prisma.user.create({ data: { email: `person-${paid.suffix}@example.test`, name: "Account Person", emailVerified: new Date() } });
    const guest = await apply(event, "guest-first");
    const guestEmail = guest.rsvp.guestEmail!;
    await prisma.user.update({ where: { id: user.id }, data: { email: guestEmail } });
    expect(await admissionRegistrationRefusal(prisma, event.id, `user:${user.id}`, [guestEmail])).toBe(ALREADY_APPLIED);
    await expect(prisma.rSVP.create({ data: { eventId: event.id, userId: user.id, attendeeKey: `user:${user.id}`, status: RsvpStatus.PENDING_APPROVAL } })).rejects.toThrow(/admission_already_applied/);

    // An account's own application: exported without reviews, scrubbed on deletion, still blocking.
    const other = await prisma.user.create({ data: { email: `leaver-${paid.suffix}@example.test`, name: "Leaving Person", emailVerified: new Date() } });
    const mine = await apply(event, "account-app", { userId: other.id });
    expect(await editApplicationAnswers(mine.token, { why: "Private reason" })).toEqual({ ok: true });
    const exported = await loadAccountApplications(other.id);
    expect(exported).toHaveLength(1);
    expect(Object.keys(exported[0]!).sort()).toEqual(["earlierAnswers", "event", "offeredAt", "organisation", "respondBy", "stage", "status", "submittedAt", "team"]);
    expect(exported[0]!.earlierAnswers).toHaveLength(1);
    await prisma.user.delete({ where: { id: other.id } });
    expect(await appOf(mine.application.id)).toMatchObject({ subjectName: "" });
    const revision = await prisma.admissionAnswerRevision.findFirstOrThrow({ where: { applicationId: mine.application.id } });
    expect(JSON.stringify(revision.answers)).not.toContain("value");
    await prisma.user.delete({ where: { id: user.id } });
  });

  it("sends the stage recorded at the change, and refuses turning applications on again", async () => {
    const { event, ctx } = await createAdmissionEvent();
    await prisma.admissionStage.create({ data: { eventId: event.id, position: 2, name: "Interview" } });
    const a = await apply(event, "staged");
    await decide(ctx, [a.application.id], "ADVANCE");
    const recorded = await prisma.admissionStatusEvent.findFirstOrThrow({ where: { applicationId: a.application.id }, orderBy: { createdAt: "desc" } });
    const interview = await prisma.admissionStage.findFirstOrThrow({ where: { eventId: event.id, position: 2 } });
    expect(recorded.stageId).toBe(interview.id);
    await drainApplicationEvents();
    expect(await prisma.admissionStatusEvent.count({ where: { applicationId: a.application.id, emittedAt: null } })).toBe(0);

    expect(await respondAsApplicant(a.token, "withdraw")).toMatchObject({ ok: true });
    await prisma.rSVP.delete({ where: { id: a.rsvp.id } });
    expect(await setAdmissionEnabled(ctx, false)).toEqual({ ok: true });
    expect(await setAdmissionEnabled(ctx, true)).toEqual({ ok: false, error: REENABLE_REFUSAL });
  });
});
