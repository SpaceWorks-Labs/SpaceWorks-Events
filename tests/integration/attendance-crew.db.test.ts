import { RsvpStatus } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Attendance confirmation and event crew (docs/ATTENDANCE.md, docs/CREW.md):
 * crew are never asked, counted, reminded, filtered as "Not asked" or given a
 * shared link, and an asked guest who joins the crew loses the question and
 * its link, so a later "No" can never release a crew ticket.
 */

const mocks = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: async () => null }));
vi.mock("@/lib/actionRateLimit", () => ({ isActionRateLimited: async () => false }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/outboxWorker", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/outboxWorker")>()), startOutboxWorker: vi.fn() }));
vi.mock("@/lib/email/attendance", () => ({ sendAttendanceCheckEmail: mocks.send }));

import { prisma } from "@/lib/db";
import {
  issueAttendanceLinkForUser, loadAttendanceCheckStatus, previewAttendanceCheckSendForUser, remindAttendanceChecksForUser,
  resolveAttendanceCheckByToken, respondToAttendanceCheck, sendAttendanceChecksForUser,
} from "@/lib/core/attendanceCheck";
import { addCrewMemberAsOrganiser } from "@/lib/core/crew/members";
import { listAttendeesPage } from "@/lib/eventDashboard/attendees";
import { ageCheck, att, guest, makeEvent, queuedFor, ref, setUpAttendance, tearDownAttendance, tokenFor } from "./helpers/attendance";

beforeAll(() => setUpAttendance());
beforeEach(() => mocks.send.mockReset());
afterAll(() => tearDownAttendance());

describe("event crew and attendance confirmation", () => {
  it("never asks crew, counts them nowhere, and drops a question when an asked guest becomes crew", async () => {
    const event = await makeEvent({ releaseOnDecline: true });
    const ctx = { organisationId: att.orgId, eventId: event.id, actorUserId: att.ownerId };
    const attendee = await guest(event.id);
    const later = await guest(event.id);
    expect(await addCrewMemberAsOrganiser(ctx, { name: "Crew Lead", email: `crew-lead-${att.suffix}@example.test` })).toMatchObject({ ok: true });
    const crewRsvp = await prisma.rSVP.findFirstOrThrow({ where: { eventId: event.id, isCrew: true } });
    expect(crewRsvp.status).toBe(RsvpStatus.CONFIRMED);

    // Preview and send count attendees only.
    expect(await previewAttendanceCheckSendForUser(att.ownerId, ref(event))).toMatchObject({ ok: true, data: { count: 2 } });
    expect(await sendAttendanceChecksForUser(att.ownerId, ref(event))).toEqual({ ok: true, data: { queued: 2 } });
    expect(await prisma.attendanceCheck.findUnique({ where: { rsvpId: crewRsvp.id } })).toBeNull();
    expect((await queuedFor(event.id)).map((message) => (message.payload as { rsvpId: string }).rsvpId)).not.toContain(crewRsvp.id);

    // No shared link for crew either.
    expect(await issueAttendanceLinkForUser(att.ownerId, { ...ref(event), rsvpId: crewRsvp.id })).toEqual({ ok: false, error: "Only confirmed guests can be asked to confirm attendance." });

    // An asked guest who then joins the crew loses the question and its link.
    const token = await tokenFor(later.id);
    expect(await addCrewMemberAsOrganiser(ctx, { name: "Promoted", email: later.guestEmail! })).toMatchObject({ ok: true });
    expect(await prisma.attendanceCheck.findUnique({ where: { rsvpId: later.id } })).toBeNull();
    expect(await resolveAttendanceCheckByToken(token)).toBeNull();
    expect(await respondToAttendanceCheck({ token, response: "NOT_ATTENDING" })).toEqual({ ok: false, error: "This link is no longer valid." });
    expect((await prisma.rSVP.findUniqueOrThrow({ where: { id: later.id } })).isCrew).toBe(true);

    const status = await loadAttendanceCheckStatus(await prisma.event.findUniqueOrThrow({ where: { id: event.id } }));
    expect(status).toMatchObject({ asked: 1, noReply: 1, notAsked: 0 });
    // Reminders reach the attendee only.
    await ageCheck(attendee.id);
    expect(await remindAttendanceChecksForUser(att.ownerId, ref(event))).toEqual({ ok: true, data: { queued: 1 } });

    // Guests · People: crew carry no badge and never count as "Not asked".
    const page = await listAttendeesPage({ kind: "event", eventId: event.id, organisationId: att.orgId }, {}, { origin: "https://events.example.test", teamMode: false });
    expect(page.attendanceCounts).toMatchObject({ notAsked: 0, noReply: 1 });
    for (const row of page.rows.filter((r) => r.id === crewRsvp.id || r.id === later.id)) expect(row.attendance.state).toBeNull();
  });
});
