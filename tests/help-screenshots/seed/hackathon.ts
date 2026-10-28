import { EventPermission, EventPrivacyType, EventStatus, JudgingStatus, RegistrationMode, RsvpStatus, SoloPolicy, SubmissionStatus } from "@prisma/client";
import { CURRENCY, DAY, HOUR, MINUTE, TIMEZONE, daysFromNow, inr, guestKey, sha256, slugify, token, type Db } from "./common";
import type { People } from "./people";

const TEAMS = [
  { name: "Byte Club", status: RsvpStatus.CONFIRMED, members: ["Ada Nwosu", "Ben Carter", "Cleo Park"], project: "FoodShare Finder", summary: "A map of community fridges and food banks with live opening times, built with open council data." },
  { name: "Night Owls", status: RsvpStatus.CONFIRMED, members: ["Dara Quinn", "Eoin Walsh", "Fatima Zahra", "Gil Mor"], project: "Volunteer Rota", summary: "A shared rota for volunteer groups that sends reminders and lets people swap shifts in two taps." },
  { name: "Pixel Pushers", status: RsvpStatus.CONFIRMED, members: ["Hana Ito", "Ivan Petrov"], project: "Accessible Bus Times", summary: "A high-contrast, screen-reader friendly view of Riverside bus departures." },
  { name: "Green Routes", status: RsvpStatus.CONFIRMED, members: ["Jade Moss", "Kofi Boateng", "Lena Vogel"], project: "Cycle Safe", summary: "Crowd-sourced reports of unsafe junctions for cyclists, shared with the council." },
  { name: "Team Lagom", status: RsvpStatus.PENDING_APPROVAL, members: ["Maja Berg", "Nils Ek"], project: null, summary: "" },
  { name: "Solo Sparks", status: RsvpStatus.PENDING_APPROVAL, members: ["Omar Haddad"], project: null, summary: "" },
];

/** A hackathon with team registration, submissions, a rubric, reviews and prize awards. */
export async function seedHackathon(prisma: Db, people: People, now: number) {
  const { org, owner, judge, judge2 } = people;
  const start = daysFromNow(now, -3, 9);
  const end = new Date(start.getTime() + 33 * HOUR);
  const hack = await prisma.event.create({
    data: {
      organisationId: org.id,
      title: "Riverside Hack Weekend",
      slug: "hack-weekend",
      description: "Two days of building tools that help Riverside's community groups.",
      tags: ["hackathon"],
      startDateTime: start,
      endDateTime: end,
      timezone: TIMEZONE,
      location: "Riverside Makerspace, 3 Mill Lane",
      capacity: 20,
      currency: CURRENCY,
      status: EventStatus.PUBLISHED,
      privacyType: EventPrivacyType.APPROVAL_REQUIRED,
      listedPublicly: true,
      registrationMode: RegistrationMode.TEAM,
      teamMinSize: 2,
      teamMaxSize: 4,
      soloPolicy: SoloPolicy.SOLO_WITH_MATCHING,
      submissionsEnabled: true,
      submissionsOpenAt: new Date(start.getTime() + 2 * HOUR),
      submissionsCloseAt: new Date(end.getTime() - HOUR),
      judgingStatus: JudgingStatus.OPEN,
      judgesSeeAll: true,
      reviewsPerProject: 3,
      createdAt: new Date(now - 60 * DAY),
      page: { create: { isPublished: true, accentColor: "#c2410c", aboutHtml: "<p>Form a team, build something useful, and show it to the judges.</p>" } },
    },
  });
  await prisma.eventCollaborator.createMany({
    data: [
      { eventId: hack.id, userId: judge.id, permissions: [EventPermission.JUDGE] },
      { eventId: hack.id, userId: judge2.id, permissions: [EventPermission.JUDGE] },
    ],
  });

  const submissions: { id: string; title: string; team: string }[] = [];
  for (const [index, entry] of TEAMS.entries()) {
    const team = await prisma.team.create({
      data: {
        eventId: hack.id, name: entry.name, nameKey: entry.name.toLowerCase(), status: entry.status, joinToken: token(), manageTokenHash: sha256(token()),
        lookingForMembers: entry.members.length < 2, createdAt: new Date(now - (30 - index) * DAY),
      },
    });
    let leaderId: string | null = null;
    for (const [memberIndex, name] of entry.members.entries()) {
      const email = `${name.toLowerCase().replace(/\s+/g, ".")}@example.org`;
      const rsvp = await prisma.rSVP.create({
        data: {
          eventId: hack.id, teamId: team.id, guestEmail: email, guestName: name, attendeeKey: guestKey(email), status: entry.status,
          createdAt: new Date(now - (30 - index) * DAY + memberIndex * HOUR),
          checkedInAt: entry.status === RsvpStatus.CONFIRMED ? new Date(start.getTime() + (index * 4 + memberIndex) * MINUTE) : null,
        },
      });
      leaderId ??= rsvp.id;
    }
    await prisma.team.update({ where: { id: team.id }, data: { leaderRsvpId: leaderId } });
    if (entry.project) {
      const slug = slugify(entry.name);
      const submission = await prisma.submission.create({
        data: {
          eventId: hack.id, teamId: team.id, title: entry.project, summary: entry.summary, repoUrl: `https://example.org/${slug}/code`, demoUrl: `https://example.org/${slug}/demo`,
          status: SubmissionStatus.SUBMITTED, submittedAt: new Date(end.getTime() - (5 - index) * HOUR),
        },
      });
      submissions.push({ id: submission.id, title: submission.title, team: entry.name });
    }
  }
  // A solo registrant who is still drafting their project.
  const soloEmail = "petra.solo@example.org";
  const solo = await prisma.rSVP.create({
    data: { eventId: hack.id, guestEmail: soloEmail, guestName: "Petra Novak", attendeeKey: guestKey(soloEmail), status: RsvpStatus.CONFIRMED, createdAt: new Date(now - 20 * DAY) },
  });
  await prisma.submission.create({ data: { eventId: hack.id, rsvpId: solo.id, title: "Library Seat Finder", summary: "Work in progress.", status: SubmissionStatus.DRAFT } });

  const criteria = [];
  for (const [position, criterion] of [
    { name: "Impact", description: "How much will this help Riverside's community groups?", weight: 3, maxScore: 10 },
    { name: "Technical execution", description: "Does it work, and is it well built?", weight: 2, maxScore: 10 },
    { name: "Presentation", description: "How clearly did the team explain the idea?", weight: 1, maxScore: 5 },
  ].entries()) {
    criteria.push(await prisma.judgingCriterion.create({ data: { eventId: hack.id, ...criterion, position } }));
  }

  // Reviews: Byte Club and Night Owls have three, Pixel Pushers one, Green Routes none.
  const reviewPlan: [number, string, number[], string][] = [
    [0, owner.id, [9, 8, 4], "Clear real-world need."],
    [0, judge.id, [8, 7, 5], "Lovely demo."],
    [0, judge2.id, [9, 6, 4], "Would like to see offline support."],
    [1, owner.id, [8, 9, 4], "Polished and easy to use."],
    [1, judge.id, [7, 9, 3], "Great technical work."],
    [1, judge2.id, [7, 8, 4], "Solid."],
    [2, judge.id, [6, 7, 5], "Very accessible design."],
  ];
  for (const [submissionIndex, judgeId, scores, comment] of reviewPlan) {
    const submissionId = submissions[submissionIndex]!.id;
    for (const [criterionIndex, score] of scores.entries()) {
      await prisma.judgeScore.create({ data: { submissionId, judgeUserId: judgeId, criterionId: criteria[criterionIndex]!.id, score } });
    }
    await prisma.judgeReview.create({ data: { submissionId, judgeUserId: judgeId, comment, submittedAt: new Date(now - 6 * HOUR) } });
  }
  const awards = [
    { name: "Overall winner", description: "The project the judges scored highest.", prize: 50000 },
    { name: "Best community impact", description: "The project most likely to help local groups.", prize: 25000 },
    { name: "Best newcomers", description: "For a team taking part for the first time.", prize: 10000 },
  ];
  for (const [position, award] of awards.entries()) {
    await prisma.eventAward.create({ data: { eventId: hack.id, name: award.name, description: award.description, position, prizeMinor: inr(award.prize) } });
  }
  return { hack, submissions };
}
