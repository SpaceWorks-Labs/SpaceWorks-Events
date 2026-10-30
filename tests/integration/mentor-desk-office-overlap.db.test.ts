import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: async () => null }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/db";
import { bookOfficeHour, createOfficeHourSlot, rescheduleOfficeHourSlot } from "@/lib/core/mentorDesk/officeHours";
import { createTeam, setUpJudgingSuite, tearDownJudgingSuite } from "./helpers/judging";
import { addMentor, createDeskEvent, goLive, HOUR, local, teamParticipant } from "./helpers/mentorDesk";

// docs/MENTOR_DESK.md "Office hours": a mentor's schedule changes are serialised, so slots never overlap.
describe.sequential("mentor desk office-hour overlaps", () => {
  beforeAll(setUpJudgingSuite);
  afterAll(tearDownJudgingSuite);

  const MINUTE = 60_000;
  const OVERLAP = "This overlaps another of the mentor's slots.";

  async function setUp() {
    let event = await createDeskEvent();
    const { teamId } = await createTeam(event, `Overlap ${Math.random().toString(36).slice(2, 7)}`);
    event = await goLive(event);
    const mentor = await addMentor(event, "overlap");
    // Whole minutes, as the slot form sends them.
    const base = Math.ceil((Date.now() + 30 * MINUTE) / MINUTE) * MINUTE;
    const window = (from: number, minutes = 30) => ({ start: local(new Date(base + from)), end: local(new Date(base + from + minutes * MINUTE)) });
    return { event, mentor, team: await teamParticipant(teamId), window };
  }

  it("lets exactly one of two concurrent overlapping slot creations through", async () => {
    const { mentor, window } = await setUp();
    for (const at of [0, HOUR, 2 * HOUR]) {
      const results = await Promise.all([
        createOfficeHourSlot(mentor, { mentorUserId: mentor.userId, ...window(at) }),
        createOfficeHourSlot(mentor, { mentorUserId: mentor.userId, ...window(at + 15 * MINUTE) }),
      ]);
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(results.filter((result) => !result.ok)).toEqual([{ ok: false, error: OVERLAP }]);
    }
    expect(await prisma.officeHourSlot.count({ where: { mentorUserId: mentor.userId, cancelledAt: null } })).toBe(3);
  });

  it("refuses a reschedule into an overlap, also against a concurrent creation, and leaves booking alone", async () => {
    const { mentor, team, window } = await setUp();
    const create = async (at: number) => {
      const created = await createOfficeHourSlot(mentor, { mentorUserId: mentor.userId, ...window(at) });
      if (!created.ok) throw new Error(created.error);
      return prisma.officeHourSlot.findUniqueOrThrow({ where: { id: created.data.id } });
    };
    const first = await create(0);
    const second = await create(HOUR);
    const move = (slot: typeof second, at: number) => rescheduleOfficeHourSlot(mentor, { slotId: slot.id, expectedVersion: slot.version, reason: "Moved", ...window(at) });
    expect(await move(second, 10 * MINUTE)).toEqual({ ok: false, error: OVERLAP });

    // A reschedule and a creation racing for the same free time: one wins.
    const raced = await Promise.all([move(second, 2 * HOUR), createOfficeHourSlot(mentor, { mentorUserId: mentor.userId, ...window(2 * HOUR + 10 * MINUTE) })]);
    expect(raced.filter((result) => result.ok)).toHaveLength(1);
    expect(raced.filter((result) => !result.ok)).toEqual([{ ok: false, error: OVERLAP }]);

    // Booking keeps its shared lock: it runs alongside a schedule change for the same mentor.
    const [booked, added] = await Promise.all([
      bookOfficeHour(team, { slotId: first.id, expectedVersion: first.version }),
      createOfficeHourSlot(mentor, { mentorUserId: mentor.userId, ...window(3 * HOUR) }),
    ]);
    expect(booked).toMatchObject({ ok: true });
    expect(added).toMatchObject({ ok: true });
    expect(await prisma.officeHourBooking.count({ where: { slotId: first.id, status: "BOOKED" } })).toBe(1);
  });
});
