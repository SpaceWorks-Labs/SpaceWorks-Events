import { randomUUID } from "node:crypto";
import { EventPermission } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/* Volunteer shifts through the mobile API (docs/VOLUNTEERS.md): own shifts by crew ticket, the organiser roster and desk, owner/admin hours. */

process.env.REDIS_URL = "";
process.env.TRUSTED_PROXY_IP_HEADER = "x-real-ip";
// Idempotency keys are stored as keyed digests (lib/mobile/idempotency.ts).
process.env.MFA_ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString("base64");

vi.mock("next-auth", () => ({ default: () => ({ auth: async () => null, handlers: {}, signIn: vi.fn(), signOut: vi.fn() }), CredentialsSignin: class extends Error {} }));
vi.mock("next-auth/providers/google", () => ({ default: vi.fn() }));
vi.mock("next-auth/providers/credentials", () => ({ default: vi.fn() }));
vi.mock("@/lib/authAdapter", () => ({ authAdapter: {} }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-real-ip": `198.18.1.${Math.floor(Math.random() * 250)}` }), cookies: async () => ({ get: () => undefined, set: vi.fn(), delete: vi.fn() }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/outboxWorker", () => ({ startOutboxWorker: vi.fn() }));

import { prisma } from "@/lib/db";
import { addCrewMemberAsOrganiser } from "@/lib/core/crew";
import { createEvent, createUser, get, keyed, params, post, signIn, unkeyed, type SignedIn } from "../helpers/mobileApi";
import { GET as myShifts } from "@/app/api/mobile/v1/me/registrations/[rsvpId]/shifts/route";
import { POST as myShiftAction } from "@/app/api/mobile/v1/me/registrations/[rsvpId]/shifts/[id]/[action]/route";
import { GET as roster } from "@/app/api/mobile/v1/orgs/[orgSlug]/events/[eventId]/volunteer-shifts/route";
import { POST as signupAction } from "@/app/api/mobile/v1/orgs/[orgSlug]/events/[eventId]/volunteer-shifts/signups/[signupId]/[action]/route";
import { POST as hoursAction } from "@/app/api/mobile/v1/orgs/[orgSlug]/events/[eventId]/volunteer-shifts/hours/[hoursId]/[action]/route";

const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
const email = (name: string) => `${name}-${suffix}@example.test`;
const orgSlug = `mob-vol-${suffix}`;
const ids = { org: "", otherOrg: "", event: "", owner: "", helper: "", volunteer: "", stranger: "", rsvp: "", soon: "", later: "" };
const tokens = {} as Record<"owner" | "helper" | "volunteer" | "stranger", SignedIn>;
const at = <E extends Record<string, string>>(extra?: E) => params({ orgSlug, eventId: ids.event, ...(extra as E) });
const mine = <E extends Record<string, string>>(extra?: E) => params({ rsvpId: ids.rsvp, ...(extra as E) });
const MINUTE = 60_000;

beforeAll(async () => {
  ids.org = (await prisma.organisation.create({ data: { name: "Volunteers mobile", slug: orgSlug } })).id;
  ids.otherOrg = (await prisma.organisation.create({ data: { name: "Other", slug: `mob-vol-other-${suffix}` } })).id;
  ids.event = await createEvent(ids.org, `vol-${suffix}`, { volunteerShiftsEnabled: true });
  for (const name of ["owner", "helper", "volunteer", "stranger"] as const) ids[name] = await createUser(email(name), name);
  await prisma.membership.create({ data: { userId: ids.owner, organisationId: ids.org, role: "OWNER" } });
  await prisma.eventCollaborator.create({ data: { userId: ids.helper, eventId: ids.event, permissions: [EventPermission.MANAGE_REGISTRATIONS] } });
  // A verified account with the crew email is linked to the crew record, so the app reaches the guest crew ticket.
  const added = await addCrewMemberAsOrganiser({ organisationId: ids.org, eventId: ids.event, actorUserId: ids.owner }, { name: "Vol Unteer", email: email("volunteer") });
  if (!added.ok) throw new Error(added.error);
  ids.rsvp = (await prisma.eventCrewMember.findUniqueOrThrow({ where: { id: added.data.id } })).rsvpId;
  const shift = (startIn: number, requiresApproval: boolean, title: string) => {
    const start = new Date(Date.now() + startIn * MINUTE);
    return prisma.volunteerShift.create({ data: { eventId: ids.event, title, startsAt: start, endsAt: new Date(start.getTime() + 120 * MINUTE), signupDeadline: start, requiresApproval, graceMinutes: 15 } });
  };
  ids.soon = (await shift(10, false, "Doors")).id;
  ids.later = (await shift(300, true, "Teardown")).id;
  for (const name of ["owner", "helper", "volunteer", "stranger"] as const) tokens[name] = await signIn(email(name));
});

afterAll(async () => {
  await prisma.outboxMessage.deleteMany({ where: { payload: { path: ["to"], string_contains: suffix } } });
  await prisma.organisation.deleteMany({ where: { id: { in: [ids.org, ids.otherOrg] } } });
  await prisma.user.deleteMany({ where: { id: { in: [ids.owner, ids.helper, ids.volunteer, ids.stranger] } } });
});

const signupFor = (shiftId: string) => prisma.volunteerShiftSignup.findFirstOrThrow({ where: { shiftId } });

describe.sequential("volunteer shifts through the mobile API", () => {
  it("shows a volunteer their own shifts and nobody else's", async () => {
    const response = await myShifts(get("/x", tokens.volunteer.accessToken), mine());
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body.data).toMatchObject({ verifiedMinutes: 0, certificateUrl: null });
    expect(body.data.shifts.map((shift: { title: string }) => shift.title)).toEqual(["Doors", "Teardown"]);
    expect((await myShifts(get("/x", tokens.stranger.accessToken), mine())).status).toBe(404);
    expect((await myShifts(get("/x"), mine())).status).toBe(401);
  });

  it("lets the volunteer sign up, check in and out of their own shift", async () => {
    const act = (id: string, action: string) => myShiftAction(post("/x", {}, tokens.volunteer.accessToken), mine({ id, action }));
    const applied = await (await act(ids.later, "apply")).json();
    expect(applied.data.shifts.find((shift: { id: string }) => shift.id === ids.later).signup).toMatchObject({ status: "APPLIED" });
    expect((await act(ids.soon, "apply")).status).toBe(200);
    const doors = await signupFor(ids.soon);
    expect(doors.status).toBe("APPROVED");
    expect((await act(doors.id, "teleport")).status).toBe(404);
    expect((await myShiftAction(post("/x", {}, tokens.stranger.accessToken), mine({ id: doors.id, action: "check-in" }))).status).toBe(404);
    expect((await act(doors.id, "check-in")).status).toBe(200);
    const out = await (await act(doors.id, "check-out")).json();
    expect(out.data.shifts.find((shift: { id: string }) => shift.id === ids.soon).signup).toMatchObject({ attendance: "CHECKED_OUT", hoursState: "PENDING" });
  });

  it("gives co-organisers with MANAGE_REGISTRATIONS the roster and approvals, and refuses everyone else", async () => {
    const response = await roster(get("/x", tokens.helper.accessToken), at());
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body.data).toMatchObject({ enabled: true, isAdmin: false });
    expect(JSON.stringify(body)).not.toContain(email("volunteer"));
    expect((await roster(get("/x", tokens.stranger.accessToken), at())).status).toBe(404);
    expect((await roster(get("/x", tokens.owner.accessToken), params({ orgSlug: `mob-vol-other-${suffix}`, eventId: ids.event }))).status).toBe(404);
    const teardown = await signupFor(ids.later);
    expect((await signupAction(post("/x", {}, tokens.helper.accessToken), at({ signupId: teardown.id, action: "launch" }))).status).toBe(404);
    // Desk and approval writes need an Idempotency-Key; a retry replays the first answer without acting twice.
    expect((await signupAction(unkeyed("/x", {}, tokens.helper.accessToken), at({ signupId: teardown.id, action: "approve" }))).status).toBe(400);
    const approved = await signupAction(keyed("/x", {}, tokens.helper.accessToken, `approve-${suffix}`), at({ signupId: teardown.id, action: "approve" }));
    expect(await approved.json()).toEqual({ ok: true, data: { signupId: teardown.id, status: "APPROVED", attendance: "SCHEDULED", minutes: null } });
    const replayed = await signupAction(keyed("/x", {}, tokens.helper.accessToken, `approve-${suffix}`), at({ signupId: teardown.id, action: "approve" }));
    expect(replayed.headers.get("Idempotent-Replayed")).toBe("true");
    await expect(signupFor(ids.later)).resolves.toMatchObject({ status: "APPROVED", approvedByUserId: ids.helper });
    // The desk needs a reason for an earlier time.
    const early = new Date(Date.now() - 5 * MINUTE).toISOString();
    const refused = await signupAction(keyed("/x", { occurredAt: early }, tokens.helper.accessToken, `early-${suffix}`), at({ signupId: teardown.id, action: "check-in" }));
    expect(refused.status).toBeGreaterThanOrEqual(400);
  });

  it("lets only owners and admins verify hours", async () => {
    const hours = await prisma.volunteerHours.findFirstOrThrow({ where: { signup: { shiftId: ids.soon } } });
    expect((await hoursAction(keyed("/x", {}, tokens.helper.accessToken, `verify-h-${suffix}`), at({ hoursId: hours.id, action: "verify" }))).status).toBe(403);
    const verified = await hoursAction(keyed("/x", {}, tokens.owner.accessToken, `verify-${suffix}`), at({ hoursId: hours.id, action: "verify" }));
    const body = await verified.json();
    expect(verified.status, JSON.stringify(body)).toBe(200);
    expect(body.data).toEqual({ hoursId: hours.id, state: "VERIFIED", minutes: hours.minutes, revokedCertificate: false });
    await expect(prisma.volunteerHours.findUniqueOrThrow({ where: { id: hours.id } })).resolves.toMatchObject({ state: "VERIFIED" });
    const adjust = await hoursAction(keyed("/x", { minutes: 5 }, tokens.owner.accessToken, `adjust-${suffix}`), at({ hoursId: hours.id, action: "adjust" }));
    expect(adjust.status).toBeGreaterThanOrEqual(400);
    const mineNow = await (await myShifts(get("/x", tokens.volunteer.accessToken), mine())).json();
    expect(mineNow.data.verifiedMinutes).toBe(hours.minutes);
  });
});
