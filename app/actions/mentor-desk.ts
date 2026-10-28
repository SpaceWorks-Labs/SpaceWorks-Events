"use server";

/*
 * Organiser actions for the event dashboard's Mentors tab (docs/MENTOR_DESK.md):
 * organisation OWNER/ADMIN only (canManageMentorDesk). The rules, locks and
 * audit events live in lib/core/mentorDesk/; these are thin, gated wrappers.
 */

import { applyAssignments, assignMentorManually, previewAssignments, transitionAssignment, type AssignmentPreview } from "@/lib/core/mentorDesk/assignments";
import { saveHelpCategory, saveMentorProfile, setMentorConflict, updateDeskSettings } from "@/lib/core/mentorDesk/configuration";
import { helpCommand } from "@/lib/core/mentorDesk/helpCommands";
import { cancelBookingAsOrganiser, cancelOfficeHourSlot, createOfficeHourSlot, rescheduleOfficeHourSlot } from "@/lib/core/mentorDesk/officeHours";
import { saveMentoringRound, setRoundMentorPool, transitionMentoringRound } from "@/lib/core/mentorDesk/rounds";
import type { DeskResult } from "@/lib/core/mentorDesk/shared";
import { asOrganiser } from "./mentorDesk/gates";

export async function updateMentorDeskSettings(input: unknown): Promise<DeskResult> {
  return asOrganiser(input, (ctx, body) => updateDeskSettings(ctx, body));
}

export async function saveMentorProfileAsOrganiser(input: unknown): Promise<DeskResult> {
  return asOrganiser(input, (ctx, body) => saveMentorProfile(ctx, body));
}

export async function saveHelpCategoryAction(input: unknown): Promise<DeskResult<{ id: string }>> {
  return asOrganiser(input, (ctx, body) => saveHelpCategory(ctx, body));
}

export async function setMentorConflictAsOrganiser(input: unknown): Promise<DeskResult> {
  return asOrganiser(input, (ctx, body) => setMentorConflict(ctx, body));
}

/** Assign, reopen, release or resolve a help request from the live board. */
export async function organiserHelpCommand(input: unknown): Promise<DeskResult> {
  return asOrganiser(input, (ctx, body) => helpCommand(ctx, body));
}

/** Writes nothing; RANDOM without a seed gets a new one ("re-roll"). */
export async function previewMentorAssignments(input: unknown): Promise<DeskResult<AssignmentPreview>> {
  return asOrganiser(input, (ctx, body) => previewAssignments(ctx, body));
}

export async function applyMentorAssignments(input: unknown): Promise<DeskResult<{ runId: string; created: number; uncovered: number }>> {
  return asOrganiser(input, (ctx, body) => applyAssignments(ctx, body));
}

export async function transitionMentorAssignment(input: unknown): Promise<DeskResult> {
  return asOrganiser(input, (ctx, body) => transitionAssignment(ctx, body));
}

export async function assignMentorManuallyAction(input: unknown): Promise<DeskResult<{ id: string }>> {
  return asOrganiser(input, (ctx, body) => assignMentorManually(ctx, body));
}

export async function createOfficeHourSlotAsOrganiser(input: unknown): Promise<DeskResult<{ id: string }>> {
  return asOrganiser(input, (ctx, body) => createOfficeHourSlot(ctx, body));
}

export async function rescheduleOfficeHourSlotAsOrganiser(input: unknown): Promise<DeskResult> {
  return asOrganiser(input, (ctx, body) => rescheduleOfficeHourSlot(ctx, body));
}

export async function cancelOfficeHourSlotAsOrganiser(input: unknown): Promise<DeskResult> {
  return asOrganiser(input, (ctx, body) => cancelOfficeHourSlot(ctx, body));
}

export async function cancelOfficeHourBookingAsOrganiser(input: unknown): Promise<DeskResult> {
  return asOrganiser(input, (ctx, body) => cancelBookingAsOrganiser(ctx, body));
}

export async function saveMentoringRoundAction(input: unknown): Promise<DeskResult<{ id: string }>> {
  return asOrganiser(input, (ctx, body) => saveMentoringRound(ctx, body));
}

export async function setRoundMentorPoolAction(input: unknown): Promise<DeskResult> {
  return asOrganiser(input, (ctx, body) => setRoundMentorPool(ctx, body));
}

export async function transitionMentoringRoundAction(input: unknown): Promise<DeskResult> {
  return asOrganiser(input, (ctx, body) => transitionMentoringRound(ctx, body));
}
