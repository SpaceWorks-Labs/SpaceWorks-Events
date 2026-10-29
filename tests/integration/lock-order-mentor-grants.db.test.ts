import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: async () => null }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/db";
import { acceptEventCollaboratorInviteToken } from "@/lib/inviteAcceptance";
import { createEventCollaboratorToken, hashEventCollaboratorToken } from "@/lib/eventCollaboratorToken";
import { setMentorConflict } from "@/lib/core/mentorDesk/configuration";
import { commentAsMentor, raiseHelp, raiseHelpAsMentor } from "@/lib/core/mentorDesk/help";
import { helpCommand } from "@/lib/core/mentorDesk/helpCommands";
import { nominateTeam } from "@/lib/core/mentorDesk/visits";
import { flushWebhookEmits } from "@/lib/webhooks/emit";
import { createTeam, organiserId, setUpJudgingSuite, tearDownJudgingSuite } from "./helpers/judging";
import { addCategory, addMentor, createDeskEvent, goLive, heldClaim, HOUR, teamParticipant } from "./helpers/mentorDesk";
import { fulfilled, holdLocks, raceBehind } from "./helpers/locks";

describe.sequential("acceptance versus mentor grant holders", () => {
  beforeAll(setUpJudgingSuite);
  afterAll(async () => { await flushWebhookEmits(); await tearDownJudgingSuite(); });

  it.each(["conflict", "comment", "nomination", "renew", "release", "resolve", "raise"] as const)(
    "takes Event before the grant for %s alongside acceptance", async (command) => {
      let event = await createDeskEvent();
      const { teamId } = await createTeam(event, `Grant ${command}`);
      event = await goLive(event);
      const mentor = await addMentor(event, `grant-${command}`);
      await addCategory(event, { key: "general", openLimit: 2 });
      const user = await prisma.user.findUniqueOrThrow({ where: { id: mentor.userId } });
      const token = createEventCollaboratorToken();
      await prisma.eventCollaboratorInvite.create({ data: {
        eventId: event.id, email: user.email!, tokenHash: hashEventCollaboratorToken(token),
        permissions: ["MENTOR"], createdByUserId: organiserId, expiresAt: new Date(Date.now() + HOUR),
      } });
      let run: () => Promise<{ ok: boolean }>;
      if (command === "conflict") {
        run = () => setMentorConflict(mentor, { mentorUserId: mentor.userId, teamId, kind: "DECLARED", active: true, expectedVersion: 0 });
      } else if (command === "nomination") {
        const round = await prisma.mentoringRound.create({ data: {
          eventId: event.id, position: 0, label: "Round", opensAt: event.startDateTime, closesAt: event.endDateTime,
        } });
        await prisma.mentoringCheckIn.create({ data: {
          eventId: event.id, roundId: round.id, teamId, mentorUserId: mentor.userId, formSnapshot: [], answers: {},
          startedAt: new Date(), submittedAt: new Date(),
        } });
        run = () => nominateTeam(mentor, { roundId: round.id, teamId });
      } else if (command === "raise") {
        run = () => raiseHelpAsMentor(mentor, { teamId, categoryKey: "general", summary: "Need help" });
      } else {
        const request = await raiseHelp(await teamParticipant(teamId), { categoryKey: "general", summary: "Need help" });
        if (!request.ok) throw new Error(request.error);
        expect(await helpCommand(mentor, { requestId: request.data.id, action: "claim", expectedVersion: 1 })).toMatchObject({ ok: true });
        const lease = await heldClaim(request.data.id);
        run = command === "comment"
          ? () => commentAsMentor(mentor, { requestId: request.data.id, expectedVersion: lease.expectedVersion, body: "On my way" })
          : () => helpCommand(mentor, { requestId: request.data.id, action: command, ...lease });
      }
      // Queue the mentor first on its grant. Previously acceptance then held
      // Event FOR UPDATE while waiting for that grant; the mentor's insert
      // needed Event FOR KEY SHARE, completing the cycle after release.
      const blocker = await holdLocks((tx) => tx.$queryRaw`
        SELECT "id" FROM "EventCollaborator" WHERE "eventId" = ${event.id} AND "userId" = ${mentor.userId} FOR UPDATE`);
      const [changed, accepted] = await raceBehind(blocker, run,
        () => acceptEventCollaboratorInviteToken(token, { id: user.id, email: user.email! }));
      expect(fulfilled(changed)).toMatchObject({ ok: true });
      expect(fulfilled(accepted)).toMatchObject({ ok: true });
    },
  );
});
