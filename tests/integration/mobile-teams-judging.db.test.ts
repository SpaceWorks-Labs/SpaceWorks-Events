import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { JudgingStatus, RsvpStatus } from "@prisma/client";

// Never let an ambient Redis or base URL leak into this suite.
process.env.REDIS_URL = "";
process.env.NEXT_PUBLIC_BASE_URL = "https://events.example.test";
process.env.TRUSTED_PROXY_IP_HEADER = "x-real-ip";

vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-real-ip": `198.51.100.${Math.floor(Math.random() * 250)}` }), cookies: async () => ({ get: () => undefined, set: vi.fn(), delete: vi.fn() }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
// Auth.js can't load under Vitest; the real lib/auth.ts presents the app session to action bodies.
vi.mock("next-auth", () => ({ default: () => ({ auth: async () => null, handlers: {}, signIn: vi.fn(), signOut: vi.fn() }), CredentialsSignin: class extends Error {} }));
vi.mock("next-auth/providers/google", () => ({ default: vi.fn() }));
vi.mock("next-auth/providers/credentials", () => ({ default: vi.fn() }));
vi.mock("@/lib/authAdapter", () => ({ authAdapter: {} }));
vi.mock("@/lib/outboxWorker", () => ({ startOutboxWorker: vi.fn() }));
// The per-action buckets (rsvp: 10/min) are covered elsewhere; this suite makes many calls as one organiser.
vi.mock("@/lib/actionRateLimit", () => ({ isActionRateLimited: async () => false }));

import { prisma } from "@/lib/db";
import { at, DQ_REASON, ids, OWNER_COMMENT, params, request, seedTeamsJudging, slugs, suffix, tokens, users } from "../helpers/mobileTeamsJudging";
import { GET as me } from "@/app/api/mobile/v1/me/route";
import { GET as myRegistrations } from "@/app/api/mobile/v1/me/registrations/route";
import { GET as myTeam } from "@/app/api/mobile/v1/me/registrations/[rsvpId]/team/route";
import { GET as orgEvents } from "@/app/api/mobile/v1/orgs/[orgSlug]/events/route";
import { GET as guestList } from "@/app/api/mobile/v1/orgs/[orgSlug]/events/[eventId]/guests/route";
import { POST as approveGuest } from "@/app/api/mobile/v1/orgs/[orgSlug]/events/[eventId]/guests/[rsvpId]/approve/route";
import { GET as lookup } from "@/app/api/mobile/v1/orgs/[orgSlug]/events/[eventId]/check-in/lookup/route";
import { GET as teamList } from "@/app/api/mobile/v1/orgs/[orgSlug]/events/[eventId]/teams/route";
import { POST as approveTeam } from "@/app/api/mobile/v1/orgs/[orgSlug]/events/[eventId]/teams/[teamId]/approve/route";
import { POST as promoteTeam } from "@/app/api/mobile/v1/orgs/[orgSlug]/events/[eventId]/teams/[teamId]/promote/route";
import { GET as judgeList } from "@/app/api/mobile/v1/orgs/[orgSlug]/events/[eventId]/judging/submissions/route";
import { GET as judgeNext } from "@/app/api/mobile/v1/orgs/[orgSlug]/events/[eventId]/judging/next/route";
import { GET as judgeCriteria } from "@/app/api/mobile/v1/orgs/[orgSlug]/events/[eventId]/judging/criteria/route";
import { GET as judgeDetail } from "@/app/api/mobile/v1/orgs/[orgSlug]/events/[eventId]/judging/submissions/[submissionId]/route";
import { PUT as judgeScores } from "@/app/api/mobile/v1/orgs/[orgSlug]/events/[eventId]/judging/submissions/[submissionId]/scores/route";
import { POST as judgeReview } from "@/app/api/mobile/v1/orgs/[orgSlug]/events/[eventId]/judging/submissions/[submissionId]/review/route";

/*
 * Mobile teams and judging (docs/MOBILE_API.md) end to end against
 * PostgreSQL: tenant isolation, the web permission rules (Teams view =
 * canManageRegistrationsFor, judging = OWNER/ADMIN or JUDGE), whole-team
 * transitions with their refusal codes, conflict of interest, and DTOs that
 * never carry emails, other judges' work, or disqualification reasons.
 */

describe.sequential("mobile teams and judging", () => {
  beforeAll(seedTeamsJudging);

  afterAll(async () => {
    await prisma.organisation.deleteMany({ where: { id: { in: [ids.orgA, ids.orgB].filter(Boolean) } } });
    await prisma.user.deleteMany({ where: { id: { in: Object.values(users).filter(Boolean) } } });
    await prisma.$disconnect();
  });

  it("tells a judge which events they can judge, and admins through the event flag", async () => {
    const judgeMe = await (await me(request("/x", tokens.judge), params({}))).json();
    expect(judgeMe.data.judging).toEqual([expect.objectContaining({ eventId: ids.event, judgingStatus: "OPEN", organisation: { slug: slugs.orgA, name: "Teams A" } })]);
    // A JUDGE-only grant is not an organiser collaboration.
    expect(judgeMe.data.collaborations).toEqual([]);
    const ownerEvents = await (await orgEvents(request("/x?filter=all", tokens.owner), params({ orgSlug: slugs.orgA }))).json();
    const listed = ownerEvents.data.events.find((row: { id: string }) => row.id === ids.event);
    expect(listed).toMatchObject({ registrationMode: "TEAM", myPermissions: { judge: true, manageRegistrations: true } });
    const doorEvents = await (await orgEvents(request("/x?filter=all", tokens.checkIn), params({ orgSlug: slugs.orgA }))).json();
    expect(doorEvents.data.events[0].myPermissions).toMatchObject({ checkIn: true, judge: false });
    // A judge-only collaborator does not see the organiser event list.
    expect((await orgEvents(request("/x", tokens.judge), params({ orgSlug: slugs.orgA }))).status).toBe(404);
  });

  it("shows an attendee their own team with display names only", async () => {
    const body = await (await myRegistrations(request("/x", tokens.leader), params({}))).json();
    const registration = body.data.upcoming.find((row: { rsvpId: string }) => row.rsvpId === ids.leaderRsvp);
    expect(registration.event.registrationMode).toBe("TEAM");
    expect(registration.team).toEqual({
      id: ids.t1, name: `Byte Club ${suffix}`, role: "LEADER", size: 2, maxSize: 4,
      members: [{ displayName: "Ada L.", isLeader: true }, { displayName: "Grace H.", isLeader: false }],
    });
    expect(JSON.stringify(body)).not.toContain("@example.test");

    const own = await myTeam(request("/x", tokens.leader), params({ rsvpId: ids.leaderRsvp }));
    expect(own.status).toBe(200);
    await expect(own.json()).resolves.toMatchObject({ ok: true, data: { team: { id: ids.t1, role: "LEADER" } } });
    // Someone else's registration (even a teammate's) is NOT_FOUND.
    expect((await myTeam(request("/x", tokens.leader), params({ rsvpId: ids.graceRsvp }))).status).toBe(404);
    expect((await myTeam(request("/x", tokens.outsider), params({ rsvpId: ids.leaderRsvp }))).status).toBe(404);
  });

  it("lists teams with the web Teams-view permission and isolates tenants", async () => {
    const response = await teamList(request("/x", tokens.owner), at());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.counts).toEqual({ ALL: 4, CONFIRMED: 1, WAITLISTED: 1, PENDING_APPROVAL: 2, REJECTED: 0, INCOMPLETE: 1, LOOKING: 0 });
    expect(body.data.teams.map((row: { id: string }) => row.id)).toEqual([ids.t1, ids.t2, ids.t3, ids.t4]);
    expect(body.data.teams[0]).toMatchObject({ leaderDisplayName: "Ada Lovelace", minSize: 2, maxSize: 4, incomplete: false });
    expect(JSON.stringify(body)).not.toContain("@example.test");

    const paged = await (await teamList(request("/x?limit=2", tokens.owner), at())).json();
    expect(paged.data.teams).toHaveLength(2);
    const next = await (await teamList(request(`/x?limit=2&cursor=${encodeURIComponent(paged.data.nextCursor)}`, tokens.owner), at())).json();
    expect(next.data.teams.map((row: { id: string }) => row.id)).toEqual([ids.t3, ids.t4]);
    const incomplete = await (await teamList(request("/x?status=INCOMPLETE", tokens.owner), at())).json();
    expect(incomplete.data.teams.map((row: { id: string }) => row.id)).toEqual([ids.t3]);
    const searched = await (await teamList(request("/x?q=hopper", tokens.owner), at())).json();
    expect(searched.data.teams.map((row: { id: string }) => row.id)).toEqual([ids.t1]);
    expect((await teamList(request("/x?cursor=garbage", tokens.owner), at())).status).toBe(400);

    // MANAGE_REGISTRATIONS grant: allowed, as on the web.
    expect((await teamList(request("/x", tokens.manager), at())).status).toBe(200);
    // CHECK_IN-only: the event is visible, the Teams view is not.
    const door = await teamList(request("/x", tokens.checkIn), at());
    expect(door.status).toBe(403);
    await expect(door.json()).resolves.toMatchObject({ error: { code: "FORBIDDEN" } });
    // JUDGE-only: no organiser surface at all.
    expect((await teamList(request("/x", tokens.judge), at())).status).toBe(404);
    // Cross-tenant: another org's admin, and another org's event id under this org.
    expect((await teamList(request("/x", tokens.otherAdmin), at())).status).toBe(404);
    expect((await teamList(request("/x", tokens.owner), params({ orgSlug: slugs.orgA, eventId: ids.otherEvent }))).status).toBe(404);
    expect((await teamList(request("/x", tokens.owner), params({ orgSlug: slugs.orgB, eventId: ids.otherEvent }))).status).toBe(404);
  });

  it("adds team names to guest rows and the check-in lookup", async () => {
    const guests = await (await guestList(request("/x", tokens.owner), at())).json();
    const grace = guests.data.guests.find((row: { rsvpId: string }) => row.rsvpId === ids.graceRsvp);
    expect(grace.teamName).toBe(`Byte Club ${suffix}`);
    const solo = guests.data.guests.find((row: { displayName: string }) => row.displayName === "Sol Solo");
    expect(solo).not.toHaveProperty("teamName");
    const found = await (await lookup(request(`/x?q=${encodeURIComponent(`Byte Club ${suffix}`)}`, tokens.checkIn), at())).json();
    expect(found.data.rows.map((row: { teamName?: string }) => row.teamName)).toEqual([`Byte Club ${suffix}`, `Byte Club ${suffix}`]);
  });

  it("refuses individual transitions on team members with TEAM_MEMBER", async () => {
    const response = await approveGuest(request("/x", tokens.owner, { method: "POST", body: {} }), at({ rsvpId: ids.t2Member }));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: { code: "TEAM_MEMBER" } });
    expect((await prisma.rSVP.findUniqueOrThrow({ where: { id: ids.t2Member } })).status).toBe(RsvpStatus.PENDING_APPROVAL);
  });

  it("approves and promotes whole teams atomically with refusal codes", async () => {
    const incomplete = await approveTeam(request("/x", tokens.owner, { method: "POST" }), at({ teamId: ids.t3 }));
    expect(incomplete.status).toBe(409);
    await expect(incomplete.json()).resolves.toMatchObject({ error: { code: "TEAM_INCOMPLETE" } });

    // Collaborators without the Teams-view permission and other tenants cannot act.
    expect((await approveTeam(request("/x", tokens.checkIn, { method: "POST" }), at({ teamId: ids.t2 }))).status).toBe(403);
    expect((await approveTeam(request("/x", tokens.owner, { method: "POST" }), at({ teamId: ids.otherTeam }))).status).toBe(404);
    expect((await approveTeam(request("/x", tokens.otherAdmin, { method: "POST" }), at({ teamId: ids.t2 }))).status).toBe(404);
    expect((await prisma.team.findUniqueOrThrow({ where: { id: ids.otherTeam } })).status).toBe(RsvpStatus.PENDING_APPROVAL);

    const approved = await approveTeam(request("/x", tokens.owner, { method: "POST" }), at({ teamId: ids.t2 }));
    expect(approved.status).toBe(200);
    await expect(approved.json()).resolves.toMatchObject({ ok: true, data: { id: ids.t2, status: "CONFIRMED", size: 2 } });
    const team = await prisma.team.findUniqueOrThrow({ where: { id: ids.t2 }, select: { status: true, members: { select: { status: true } } } });
    expect(team.status).toBe(RsvpStatus.CONFIRMED);
    expect(team.members.map((member) => member.status)).toEqual([RsvpStatus.CONFIRMED, RsvpStatus.CONFIRMED]);
    await expect(prisma.auditEvent.count({ where: { action: "TEAM_APPROVED", targetId: ids.t2 } })).resolves.toBe(1);

    // Capacity 3 is now full (T1, the solo registrant, T2).
    const full = await promoteTeam(request("/x", tokens.owner, { method: "POST" }), at({ teamId: ids.t4 }));
    expect(full.status).toBe(409);
    await expect(full.json()).resolves.toMatchObject({ error: { code: "CAPACITY_FULL" } });
    const again = await approveTeam(request("/x", tokens.owner, { method: "POST" }), at({ teamId: ids.t2 }));
    await expect(again.json()).resolves.toMatchObject({ error: { code: "CONFLICT" } });
  });

  it("lets a JUDGE-only collaborator score but never list guests", async () => {
    expect((await guestList(request("/x", tokens.judge), at())).status).toBe(404);
    const list = await judgeList(request("/x", tokens.judge), at());
    expect(list.status).toBe(200);
    const body = await list.json();
    expect(body.data.judgingStatus).toBe("OPEN");
    // The disqualified project is never listed.
    expect(body.data.submissions.map((row: { id: string }) => row.id)).toEqual([ids.s1, ids.s2, ids.s3]);
    expect(body.data.counts).toEqual({ all: 3, todo: 3, inProgress: 0, reviewed: 0 });
    expect(body.data.submissions[0]).toMatchObject({ teamName: `Byte Club ${suffix}`, links: { repo: "https://git.example/bus", demo: null, video: null }, myReview: { status: "NONE" } });
    expect(body.data.submissions[2]).toMatchObject({ entrantName: "Sol S." });
    expect(body.data.submissions[2]).not.toHaveProperty("teamName");
    expect(JSON.stringify(body)).not.toContain("@example.test");
    expect(JSON.stringify(body)).not.toContain(DQ_REASON);
    expect((await judgeDetail(request("/x", tokens.judge), at({ submissionId: ids.s4 }))).status).toBe(404);

    const criteria = await (await judgeCriteria(request("/x", tokens.judge), at())).json();
    expect(criteria.data.criteria.map((row: { id: string }) => row.id)).toEqual([ids.c1, ids.c2]);

    // The owner saves a review first; the judge never sees it.
    expect((await judgeScores(request("/x", tokens.owner, { method: "PUT", body: { scores: [{ criterionId: ids.c1, score: 2 }], comment: OWNER_COMMENT } }), at({ submissionId: ids.s1 }))).status).toBe(200);

    const partial = await judgeScores(request("/x", tokens.judge, { method: "PUT", body: { scores: [{ criterionId: ids.c1, score: 9 }], comment: "Draft note" } }), at({ submissionId: ids.s1 }));
    expect(partial.status).toBe(200);
    await expect(partial.json()).resolves.toEqual({ ok: true, data: { scored: 1, total: 2, myReview: { status: "DRAFT", scoredCriteria: 1 } } });
    const outOfRange = await judgeScores(request("/x", tokens.judge, { method: "PUT", body: { scores: [{ criterionId: ids.c2, score: 9 }] } }), at({ submissionId: ids.s1 }));
    await expect(outOfRange.json()).resolves.toMatchObject({ error: { code: "INVALID_REQUEST" } });

    const incomplete = await judgeReview(request("/x", tokens.judge, { method: "POST", body: {} }), at({ submissionId: ids.s1 }));
    expect(incomplete.status).toBe(409);
    await expect(incomplete.json()).resolves.toMatchObject({ error: { code: "INCOMPLETE_SCORES" } });

    const submitted = await judgeReview(request("/x", tokens.judge, { method: "POST", body: { scores: [{ criterionId: ids.c2, score: 4 }] } }), at({ submissionId: ids.s1 }));
    expect(submitted.status).toBe(200);
    const detail = await submitted.json();
    expect(detail.data).toMatchObject({ myComment: "Draft note", submission: { id: ids.s1, myReview: { status: "SUBMITTED", scoredCriteria: 2 } } });
    expect(detail.data.mySubmittedAt).not.toBeNull();
    expect(detail.data.myScores).toEqual(expect.arrayContaining([{ criterionId: ids.c1, score: 9 }, { criterionId: ids.c2, score: 4 }]));
    expect(JSON.stringify(detail)).not.toContain(OWNER_COMMENT);

    const next = await (await judgeNext(request("/x", tokens.judge), at())).json();
    expect(next.data.next.submission.id).not.toBe(ids.s1);
    expect(next.data.remaining).toBe(2);
    expect(JSON.stringify(next)).not.toContain(OWNER_COMMENT);
  });

  it("excludes a judge's own team (conflict of interest) everywhere", async () => {
    const list = await (await judgeList(request("/x", tokens.conflicted), at())).json();
    expect(list.data.submissions.map((row: { id: string }) => row.id)).toEqual([ids.s1, ids.s3]);
    const hidden = await judgeDetail(request("/x", tokens.conflicted), at({ submissionId: ids.s2 }));
    expect(hidden.status).toBe(404);
    await expect(hidden.json()).resolves.toMatchObject({ error: { code: "NOT_VISIBLE" } });
    const scored = await judgeScores(request("/x", tokens.conflicted, { method: "PUT", body: { scores: [{ criterionId: ids.c1, score: 10 }] } }), at({ submissionId: ids.s2 }));
    await expect(scored.json()).resolves.toMatchObject({ error: { code: "NOT_VISIBLE" } });
    const reviewed = await judgeReview(request("/x", tokens.conflicted, { method: "POST", body: {} }), at({ submissionId: ids.s2 }));
    await expect(reviewed.json()).resolves.toMatchObject({ error: { code: "NOT_VISIBLE" } });
    await expect(prisma.judgeScore.count({ where: { submissionId: ids.s2, judgeUserId: users.conflicted } })).resolves.toBe(0);
  });

  it("keeps judging to judges and the event's own organisation", async () => {
    // Visible to a CHECK_IN collaborator, but they are not a judge.
    const door = await judgeList(request("/x", tokens.checkIn), at());
    expect(door.status).toBe(403);
    expect((await judgeList(request("/x", tokens.outsider), at())).status).toBe(404);
    expect((await judgeList(request("/x", tokens.otherAdmin), at())).status).toBe(404);
    expect((await judgeList(request("/x", tokens.judge), params({ orgSlug: slugs.orgA, eventId: ids.otherEvent }))).status).toBe(404);
    expect((await judgeDetail(request("/x", tokens.otherAdmin), params({ orgSlug: slugs.orgB, eventId: ids.otherEvent, submissionId: ids.s1 }))).status).toBe(404);
  });

  it("refuses scores once judging is closed", async () => {
    await prisma.event.update({ where: { id: ids.event }, data: { judgingStatus: JudgingStatus.CLOSED } });
    const closed = await judgeScores(request("/x", tokens.judge, { method: "PUT", body: { scores: [{ criterionId: ids.c1, score: 1 }] } }), at({ submissionId: ids.s3 }));
    expect(closed.status).toBe(409);
    await expect(closed.json()).resolves.toMatchObject({ error: { code: "JUDGING_CLOSED" } });
    const next = await (await judgeNext(request("/x", tokens.judge), at())).json();
    expect(next.data).toEqual({ next: null, remaining: 0 });
  });

  it("answers NOT_FOUND on every judging route once submissions are turned off", async () => {
    await prisma.event.update({ where: { id: ids.event }, data: { submissionsEnabled: false, judgingStatus: JudgingStatus.OPEN } });
    try {
      // The owner passes the judge check without the event taking submissions; the JUDGE collaborator likewise.
      for (const token of [tokens.owner, tokens.judge]) {
        const responses = [
          await judgeList(request("/x", token), at()),
          await judgeNext(request("/x", token), at()),
          await judgeCriteria(request("/x", token), at()),
          await judgeDetail(request("/x", token), at({ submissionId: ids.s3 })),
          await judgeScores(request("/x", token, { method: "PUT", body: { scores: [{ criterionId: ids.c1, score: 1 }] } }), at({ submissionId: ids.s3 })),
          await judgeReview(request("/x", token, { method: "POST", body: {} }), at({ submissionId: ids.s3 })),
        ];
        for (const response of responses) {
          expect(response.status).toBe(404);
          await expect(response.json()).resolves.toMatchObject({ error: { code: "NOT_FOUND" } });
        }
      }
      await expect(prisma.judgeScore.count({ where: { submissionId: ids.s3 } })).resolves.toBe(0);
    } finally {
      await prisma.event.update({ where: { id: ids.event }, data: { submissionsEnabled: true, judgingStatus: JudgingStatus.CLOSED } });
    }
  });
});
