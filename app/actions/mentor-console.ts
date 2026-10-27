"use server";

/*
 * The mentor console's actions (docs/MENTOR_DESK.md): MENTOR grant holders
 * past the staff authenticator check. Each core re-checks the live grant and,
 * for queue and visit commands, the mentor's availability window.
 */

import { saveMentorProfile, setMentorConflict } from "@/lib/core/mentorDesk/configuration";
import { commentAsMentor, raiseHelpAsMentor } from "@/lib/core/mentorDesk/help";
import { helpCommand } from "@/lib/core/mentorDesk/helpCommands";
import { cancelOfficeHourSlot, createOfficeHourSlot, rescheduleOfficeHourSlot } from "@/lib/core/mentorDesk/officeHours";
import type { DeskResult } from "@/lib/core/mentorDesk/shared";
import { nominateTeam, visitCommand } from "@/lib/core/mentorDesk/visits";
import { asMentor } from "./mentorDesk/gates";

/** Claim, renew, release or resolve. */
export async function mentorHelpCommand(input: unknown): Promise<DeskResult> {
  return asMentor(input, (ctx, body) => helpCommand(ctx, body));
}

export async function mentorRaiseHelp(input: unknown): Promise<DeskResult<{ id: string }>> {
  return asMentor(input, (ctx, body) => raiseHelpAsMentor(ctx, body));
}

export async function mentorCommentOnHelp(input: unknown): Promise<DeskResult> {
  return asMentor(input, (ctx, body) => commentAsMentor(ctx, body));
}

/** Own profile, conflicts and slots: the mentor is always the signed-in user. */
export async function saveOwnMentorProfile(input: unknown): Promise<DeskResult> {
  return asMentor(input, (ctx, body) => saveMentorProfile(ctx, { ...body, mentorUserId: ctx.userId }));
}

export async function declareMentorConflict(input: unknown): Promise<DeskResult> {
  return asMentor(input, (ctx, body) => setMentorConflict(ctx, { ...body, mentorUserId: ctx.userId }));
}

export async function createOwnOfficeHourSlot(input: unknown): Promise<DeskResult<{ id: string }>> {
  return asMentor(input, (ctx, body) => createOfficeHourSlot(ctx, { ...body, mentorUserId: ctx.userId }));
}

export async function rescheduleOwnOfficeHourSlot(input: unknown): Promise<DeskResult> {
  return asMentor(input, (ctx, body) => rescheduleOfficeHourSlot(ctx, body));
}

export async function cancelOwnOfficeHourSlot(input: unknown): Promise<DeskResult> {
  return asMentor(input, (ctx, body) => cancelOfficeHourSlot(ctx, body));
}

/** Round visits: claim, heartbeat, release, submit. */
export async function mentorVisitCommand(input: unknown): Promise<DeskResult<{ leaseId?: string; generation?: number; checkInId?: string }>> {
  return asMentor(input, (ctx, body) => visitCommand(ctx, body));
}

export async function nominateTeamAction(input: unknown): Promise<DeskResult> {
  return asMentor(input, (ctx, body) => nominateTeam(ctx, body));
}
