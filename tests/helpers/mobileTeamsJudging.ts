import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { expect } from "vitest";
import { EventPermission, EventPrivacyType, EventStatus, JudgingStatus, RegistrationMode, RsvpStatus, SoloPolicy, SubmissionStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { POST as login } from "@/app/api/mobile/v1/auth/login/route";

/* The seeded hackathon behind tests/integration/mobile-teams-judging.db.test.ts. */

export const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
const PASSWORD = "correct horse battery staple";
export const HOUR = 60 * 60_000;
export const email = (name: string) => `${name.toLowerCase()}-${suffix}@example.test`;
export const slugs = { orgA: `mtj-a-${suffix}`, orgB: `mtj-b-${suffix}` };
export const users = { owner: "", otherAdmin: "", checkIn: "", manager: "", judge: "", conflicted: "", leader: "", outsider: "" };
export const ids = {
  orgA: "", orgB: "", event: "", otherEvent: "",
  t1: "", t2: "", t3: "", t4: "", otherTeam: "",
  leaderRsvp: "", graceRsvp: "", t2Member: "", conflictedRsvp: "", otherRsvp: "",
  s1: "", s2: "", s3: "", s4: "", c1: "", c2: "",
};
export const tokens: Record<keyof typeof users, string> = { owner: "", otherAdmin: "", checkIn: "", manager: "", judge: "", conflicted: "", leader: "", outsider: "" };
export const DQ_REASON = `Disqualified for plagiarism ${suffix}`;
export const OWNER_COMMENT = `Owner private comment ${suffix}`;

export function request(path: string, token: string, init: { method?: string; body?: unknown } = {}) {
  return new Request(`https://events.example.test${path}`, {
    method: init.method ?? "GET",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
}
export const params = <T extends Record<string, string>>(value: T) => ({ params: Promise.resolve(value) });
export const at = <T extends Record<string, string> = Record<never, string>>(extra?: T) =>
  params({ orgSlug: slugs.orgA, eventId: ids.event, ...(extra ?? ({} as T)) });

async function signIn(name: keyof typeof users) {
  const response = await login(new Request("https://events.example.test/api/mobile/v1/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", "x-real-ip": `198.51.100.${Math.floor(Math.random() * 250)}` },
    body: JSON.stringify({ email: email(name), password: PASSWORD, deviceId: randomUUID().replaceAll("-", ""), deviceName: "Test phone", platform: "android" }),
  }), params({}));
  expect(response.status).toBe(200);
  return ((await response.json()).data as { accessToken: string }).accessToken;
}

export async function guestRsvp(eventId: string, name: string, status: RsvpStatus, teamId: string | null = null) {
  const guestEmail = `${name.toLowerCase().replaceAll(" ", ".")}-${randomUUID().slice(0, 8)}@example.test`;
  return prisma.rSVP.create({ data: { eventId, guestName: name, guestEmail, attendeeKey: `guest:${guestEmail}`, status, teamId } });
}

export async function userRsvp(eventId: string, userId: string, status: RsvpStatus, teamId: string | null = null) {
  return prisma.rSVP.create({ data: { eventId, userId, attendeeKey: `user:${userId}`, status, teamId } });
}

export async function team(eventId: string, name: string, status: RsvpStatus) {
  return prisma.team.create({ data: { eventId, name, nameKey: name.toLowerCase(), status, joinToken: randomUUID(), manageTokenHash: randomUUID() } });
}

export async function createEvent(organisationId: string, slug: string) {
  return prisma.event.create({ data: {
    organisationId, title: `Hack ${slug}`, slug,
    startDateTime: new Date(Date.now() + 2 * HOUR), endDateTime: new Date(Date.now() + 26 * HOUR),
    timezone: "UTC", status: EventStatus.PUBLISHED, privacyType: EventPrivacyType.PUBLIC,
    registrationMode: RegistrationMode.TEAM, teamMinSize: 2, teamMaxSize: 4, soloPolicy: SoloPolicy.SOLO_ALLOWED, capacity: 3,
    submissionsEnabled: true, judgingStatus: JudgingStatus.OPEN, judgesSeeAll: true,
    page: { create: { isPublished: true } },
  } });
}


/** Two organisations, a TEAM hackathon with teams, submissions and criteria, and a signed-in app session per person. */
export async function seedTeamsJudging() {
    const [orgA, orgB] = await Promise.all([
      prisma.organisation.create({ data: { name: "Teams A", slug: slugs.orgA } }),
      prisma.organisation.create({ data: { name: "Teams B", slug: slugs.orgB } }),
    ]);
    ids.orgA = orgA.id;
    ids.orgB = orgB.id;
    const passwordHash = await bcrypt.hash(PASSWORD, 4);
    const names: Record<keyof typeof users, string> = {
      owner: "Olive Owner", otherAdmin: "Otto Admin", checkIn: "Chris Door", manager: "Mona Manager",
      judge: "Judy Judge", conflicted: "Conrad Conflict", leader: "Ada Lovelace", outsider: "Oscar Out",
    };
    for (const key of Object.keys(users) as Array<keyof typeof users>) {
      users[key] = (await prisma.user.create({ data: { email: email(key), name: names[key], emailVerified: new Date(), passwordHash } })).id;
    }
    await prisma.membership.create({ data: { userId: users.owner, organisationId: orgA.id, role: "OWNER" } });
    await prisma.membership.create({ data: { userId: users.otherAdmin, organisationId: orgB.id, role: "ADMIN" } });

    const event = await createEvent(orgA.id, `mtj-event-${suffix}`);
    const otherEvent = await createEvent(orgB.id, `mtj-other-${suffix}`);
    ids.event = event.id;
    ids.otherEvent = otherEvent.id;
    await prisma.eventCollaborator.createMany({ data: [
      { userId: users.checkIn, eventId: event.id, permissions: [EventPermission.CHECK_IN] },
      { userId: users.manager, eventId: event.id, permissions: [EventPermission.MANAGE_REGISTRATIONS] },
      { userId: users.judge, eventId: event.id, permissions: [EventPermission.JUDGE] },
      { userId: users.conflicted, eventId: event.id, permissions: [EventPermission.JUDGE] },
    ] });

    // T1: confirmed, led by the signed-in attendee (one unit).
    const t1 = await team(event.id, `Byte Club ${suffix}`, RsvpStatus.CONFIRMED);
    ids.t1 = t1.id;
    ids.leaderRsvp = (await userRsvp(event.id, users.leader, RsvpStatus.CONFIRMED, t1.id)).id;
    ids.graceRsvp = (await guestRsvp(event.id, "Grace Hopper", RsvpStatus.CONFIRMED, t1.id)).id;
    await prisma.team.update({ where: { id: t1.id }, data: { leaderRsvpId: ids.leaderRsvp } });
    // T2: pending, two members; the conflicted judge belongs to it.
    const t2 = await team(event.id, `Pending Pals ${suffix}`, RsvpStatus.PENDING_APPROVAL);
    ids.t2 = t2.id;
    ids.t2Member = (await guestRsvp(event.id, "Pat Pending", RsvpStatus.PENDING_APPROVAL, t2.id)).id;
    ids.conflictedRsvp = (await userRsvp(event.id, users.conflicted, RsvpStatus.PENDING_APPROVAL, t2.id)).id;
    await prisma.team.update({ where: { id: t2.id }, data: { leaderRsvpId: ids.t2Member } });
    // T3: pending and below the minimum size.
    const t3 = await team(event.id, `Lonely ${suffix}`, RsvpStatus.PENDING_APPROVAL);
    ids.t3 = t3.id;
    await guestRsvp(event.id, "Lou Lone", RsvpStatus.PENDING_APPROVAL, t3.id);
    // T4: waitlisted, two members.
    const t4 = await team(event.id, `Wait Here ${suffix}`, RsvpStatus.WAITLISTED);
    ids.t4 = t4.id;
    await guestRsvp(event.id, "Wes Wait", RsvpStatus.WAITLISTED, t4.id);
    await guestRsvp(event.id, "Willa Wait", RsvpStatus.WAITLISTED, t4.id);
    // A confirmed solo registrant (one unit): T1 + solo + T2 fills capacity 3.
    const solo = await guestRsvp(event.id, "Sol Solo", RsvpStatus.CONFIRMED);
    // Another organisation's team.
    const otherTeam = await team(otherEvent.id, `Elsewhere ${suffix}`, RsvpStatus.PENDING_APPROVAL);
    ids.otherTeam = otherTeam.id;
    ids.otherRsvp = (await guestRsvp(otherEvent.id, "Eve Else", RsvpStatus.PENDING_APPROVAL, otherTeam.id)).id;
    await guestRsvp(otherEvent.id, "Eli Else", RsvpStatus.PENDING_APPROVAL, otherTeam.id);

    const base = Date.now() - 10 * HOUR;
    ids.s1 = (await prisma.submission.create({ data: { eventId: event.id, teamId: t1.id, title: "Bus Buddy", summary: "Buses", repoUrl: "https://git.example/bus", status: SubmissionStatus.SUBMITTED, submittedAt: new Date(base) } })).id;
    ids.s2 = (await prisma.submission.create({ data: { eventId: event.id, teamId: t2.id, title: "Pal Finder", status: SubmissionStatus.SUBMITTED, submittedAt: new Date(base + 60_000) } })).id;
    ids.s3 = (await prisma.submission.create({ data: { eventId: event.id, rsvpId: solo.id, title: "Solo Song", status: SubmissionStatus.SUBMITTED, submittedAt: new Date(base + 120_000) } })).id;
    ids.s4 = (await prisma.submission.create({ data: { eventId: event.id, teamId: t4.id, title: "Copied", status: SubmissionStatus.DISQUALIFIED, submittedAt: new Date(base + 180_000), disqualifiedReason: DQ_REASON } })).id;
    await prisma.submission.create({ data: { eventId: otherEvent.id, teamId: otherTeam.id, title: "Other org project", status: SubmissionStatus.SUBMITTED, submittedAt: new Date(base) } });
    ids.c1 = (await prisma.judgingCriterion.create({ data: { eventId: event.id, name: "Impact", weight: 2, maxScore: 10, position: 0 } })).id;
    ids.c2 = (await prisma.judgingCriterion.create({ data: { eventId: event.id, name: "Execution", weight: 1, maxScore: 5, position: 1 } })).id;

    for (const key of Object.keys(users) as Array<keyof typeof users>) tokens[key] = await signIn(key);
}
