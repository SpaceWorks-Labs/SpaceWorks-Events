import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/*
 * The Mentor Desk through the mobile API (docs/MENTOR_DESK.md): participants
 * by their own signed-in confirmed registration, mentors past the staff
 * authenticator check, organisers by role; idempotent writes; one winner of
 * a claim race; mentor isolation and tenancy.
 */

process.env.REDIS_URL = "";
process.env.TRUSTED_PROXY_IP_HEADER = "x-real-ip";
process.env.MFA_ENCRYPTION_KEY ||= Buffer.alloc(32, 9).toString("base64");

vi.mock("next-auth", () => ({ default: () => ({ auth: async () => null, handlers: {}, signIn: vi.fn(), signOut: vi.fn() }), CredentialsSignin: class extends Error {} }));
vi.mock("next-auth/providers/google", () => ({ default: vi.fn() }));
vi.mock("next-auth/providers/credentials", () => ({ default: vi.fn() }));
vi.mock("@/lib/authAdapter", () => ({ authAdapter: {} }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-real-ip": `198.18.2.${Math.floor(Math.random() * 250)}` }), cookies: async () => ({ get: () => undefined, set: vi.fn(), delete: vi.fn() }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/actionRateLimit", () => ({ isActionRateLimited: async () => false }));

import { prisma } from "@/lib/db";
import { appSession, get, keyed, params } from "../helpers/mobileApi";
import { createTeam, createUser, organiserId, orgSlug, otherOrgSlug, setUpJudgingSuite, tearDownJudgingSuite } from "./helpers/judging";
import { addCategory, addMentor, createDeskEvent, goLive, requestVersion } from "./helpers/mentorDesk";
import { GET as desk } from "@/app/api/mobile/v1/me/mentoring/[orgSlug]/[eventId]/route";
import { POST as raise } from "@/app/api/mobile/v1/me/mentoring/[orgSlug]/[eventId]/help/route";
import { GET as helpDetail } from "@/app/api/mobile/v1/me/mentoring/[orgSlug]/[eventId]/help/[requestId]/route";
import { GET as consoleView } from "@/app/api/mobile/v1/orgs/[orgSlug]/events/[eventId]/mentor/route";
import { GET as queue } from "@/app/api/mobile/v1/orgs/[orgSlug]/events/[eventId]/mentor/queue/route";
import { POST as helpCommand } from "@/app/api/mobile/v1/orgs/[orgSlug]/events/[eventId]/mentor/help/[requestId]/[command]/route";
import { GET as deskQueue } from "@/app/api/mobile/v1/orgs/[orgSlug]/events/[eventId]/mentor-desk/queue/route";
import { GET as eventDetail } from "@/app/api/mobile/v1/orgs/[orgSlug]/events/[eventId]/route";
import { GET as mentorTeams } from "@/app/api/mobile/v1/orgs/[orgSlug]/events/[eventId]/mentor/teams/route";
import { POST as teamConflict } from "@/app/api/mobile/v1/orgs/[orgSlug]/events/[eventId]/mentor/teams/[teamId]/conflict/route";
import { POST as raiseForTeam } from "@/app/api/mobile/v1/orgs/[orgSlug]/events/[eventId]/mentor/teams/[teamId]/help/route";

let eventId = "";
let memberToken = "";
let outsiderToken = "";
let mentorA = { userId: "", token: "" };
let mentorB = { userId: "", token: "" };

beforeAll(async () => {
  await setUpJudgingSuite();
  let event = await createDeskEvent();
  const member = await createUser("member");
  await createTeam(event, `Byte ${Math.random().toString(36).slice(2, 8)}`, member.id);
  event = await goLive(event);
  eventId = event.id;
  await addCategory(event, { key: "code", openLimit: 2 });
  const [a, b] = [await addMentor(event, "mentor-a"), await addMentor(event, "mentor-b")];
  memberToken = await appSession(member.id);
  outsiderToken = await appSession((await createUser("outsider")).id);
  mentorA = { userId: a.userId, token: await appSession(a.userId) };
  mentorB = { userId: b.userId, token: await appSession(b.userId) };
});

afterAll(tearDownJudgingSuite);

const scope = () => params({ orgSlug, eventId });
const raiseBody = { categoryKey: "code", summary: "Our build fails on deploy", location: "Table 12" };

describe.sequential("the Mentor Desk through the mobile API", () => {
  it("raises help once per Idempotency-Key and replays the first answer", async () => {
    expect((await raise(keyed("/x", raiseBody, memberToken, ""), scope())).status).toBe(400);
    const first = await raise(keyed("/x", raiseBody, memberToken, "raise-key-0001"), scope());
    const body = await first.json();
    expect(first.status, JSON.stringify(body)).toBe(201);
    const replayed = await raise(keyed("/x", raiseBody, memberToken, "raise-key-0001"), scope());
    expect(replayed.headers.get("idempotent-replayed")).toBe("true");
    await expect(replayed.json()).resolves.toEqual(body);
    await expect(prisma.helpRequest.count({ where: { eventId } })).resolves.toBe(1);
    // The same key with another body is refused.
    expect((await raise(keyed("/x", { ...raiseBody, summary: "Different" }, memberToken, "raise-key-0001"), scope())).status).toBe(409);
    // The stored answer holds the id only, never the help text.
    const stored = await prisma.mobileIdempotencyKey.findFirstOrThrow({ where: { route: { contains: "/help" }, user: { mobileSessions: { some: {} } } } });
    expect(JSON.stringify(stored)).not.toContain("build fails");
  });

  it("shows the team its own requests, and nobody else", async () => {
    const view = await (await desk(get("/x", memberToken), scope())).json();
    expect(view.data.requests).toEqual([expect.objectContaining({ summary: "Our build fails on deploy", status: "OPEN" })]);
    const id = view.data.requests[0].id;
    expect((await helpDetail(get("/x", memberToken), params({ orgSlug, eventId, requestId: id }))).status).toBe(200);
    expect((await desk(get("/x", outsiderToken), scope())).status).toBe(404);
    expect((await helpDetail(get("/x", outsiderToken), params({ orgSlug, eventId, requestId: id }))).status).toBe(404);
    expect((await raise(keyed("/x", raiseBody, outsiderToken, "outsider-key-01"), scope())).status).toBe(404);
  });

  it("lets exactly one of two mentors win a simultaneous claim", async () => {
    const request = await prisma.helpRequest.findFirstOrThrow({ where: { eventId } });
    const version = await requestVersion(request.id);
    const at = params({ orgSlug, eventId, requestId: request.id, command: "claim" });
    const results = await Promise.all([mentorA, mentorB].map((m, index) => helpCommand(keyed("/x", { expectedVersion: version }, m.token, `claim-race-${index}0`), at)));
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const row = await prisma.helpRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect(row.status).toBe("CLAIMED");
    // The winner's console holds the claim; the loser's queue no longer lists it.
    const winner = row.claimedByUserId === mentorA.userId ? mentorA : mentorB;
    const loser = winner === mentorA ? mentorB : mentorA;
    const held = await (await consoleView(get("/x", winner.token), scope())).json();
    expect(held.data.claim).toMatchObject({ id: request.id, claimGeneration: 1 });
    const open = await (await queue(get("/x", loser.token), scope())).json();
    expect(open.data.requests).toEqual([]);
    expect((await helpCommand(keyed("/x", {}, winner.token, "bad-command-01"), params({ orgSlug, eventId, requestId: request.id, command: "steal" }))).status).toBe(404);
  });

  it("keeps mentors to the console and organisers to their own events", async () => {
    // MENTOR is isolated like JUDGE: no organiser tools.
    expect((await eventDetail(get("/x", mentorA.token), scope())).status).toBe(404);
    expect((await deskQueue(get("/x", mentorA.token), scope())).status).toBe(404);
    expect((await consoleView(get("/x", memberToken), scope())).status).toBe(404);
    expect((await consoleView(get("/x", mentorA.token), params({ orgSlug: otherOrgSlug, eventId }))).status).toBe(404);
    const organiser = await appSession(organiserId);
    const view = await (await deskQueue(get("/x", organiser), scope())).json();
    expect(view.data.requests).toHaveLength(1);
    expect(JSON.stringify(view)).not.toContain("@example.test");
    expect((await consoleView(get("/x", organiser), scope())).status).toBe(403);
  });

  it("lets a mentor raise help for a team and declare and clear a conflict, like the website", async () => {
    const team = await prisma.team.findFirstOrThrow({ where: { eventId } });
    const at = params({ orgSlug, eventId, teamId: team.id });
    const body = { categoryKey: "code", summary: "Raised by a mentor" };
    const raised = await raiseForTeam(keyed("/x", body, mentorB.token, "mentor-raise-01"), at);
    expect(raised.status).toBe(201);
    const { data } = await raised.json();
    expect(await prisma.helpRequest.findUniqueOrThrow({ where: { id: data.id } })).toMatchObject({ origin: "MENTOR", teamId: team.id, raisedByUserId: mentorB.userId });
    expect((await raiseForTeam(keyed("/x", body, mentorB.token, "mentor-raise-01"), at)).headers.get("idempotent-replayed")).toBe("true");
    expect((await raiseForTeam(keyed("/x", body, memberToken, "member-raise-01"), at)).status).toBe(404);
    expect((await teamConflict(keyed("/x", { active: true, expectedVersion: 0, reason: "Former colleague" }, mentorB.token, "conflict-on-01"), at)).status).toBe(200);
    const view = await (await mentorTeams(get("/x", mentorB.token), scope())).json();
    const conflict = view.data.conflicts.find((c: { teamId: string }) => c.teamId === team.id);
    expect(conflict).toMatchObject({ kind: "DECLARED", mine: true });
    expect(JSON.stringify(view)).not.toContain("Former colleague");
    expect((await teamConflict(keyed("/x", { active: false, expectedVersion: conflict.version }, mentorB.token, "conflict-off-01"), at)).status).toBe(200);
    expect(await prisma.mentorConflict.count({ where: { eventId, mentorUserId: mentorB.userId, active: true } })).toBe(0);
  });

  it("holds a mentor-only app session to a fresh authenticator check", async () => {
    vi.stubEnv("STAFF_MFA_REQUIRED", "true");
    try {
      await prisma.user.update({ where: { id: mentorA.userId }, data: { mfaEnabledAt: new Date() } });
      const unverified = await appSession(mentorA.userId, { mfa: false });
      const refused = await consoleView(get("/x", unverified), scope());
      expect(refused.status).toBe(403);
      await expect(refused.json()).resolves.toMatchObject({ error: { code: "STAFF_MFA_REQUIRED" } });
      expect((await consoleView(get("/x", await appSession(mentorA.userId)), scope())).status).toBe(200);
    } finally {
      vi.stubEnv("STAFF_MFA_REQUIRED", "false");
    }
  });
});
