"use server";

/*
 * Participant actions on the Mentor Desk (docs/MENTOR_DESK.md): the team's
 * management link, or the signed-in owner of a CONFIRMED registration. A
 * ticket link alone never raises help or books office hours.
 */

import { cancelHelp, commentAsParticipant, raiseHelp, rateHelp } from "@/lib/core/mentorDesk/help";
import { bookOfficeHour, cancelOfficeHourBooking } from "@/lib/core/mentorDesk/officeHours";
import type { DeskResult } from "@/lib/core/mentorDesk/shared";
import { asParticipant } from "./mentorDesk/gates";

export async function raiseHelpRequest(input: unknown): Promise<DeskResult<{ id: string }>> {
  return asParticipant(input, (ctx, body) => raiseHelp(ctx, body));
}

export async function cancelHelpRequest(input: unknown): Promise<DeskResult> {
  return asParticipant(input, (ctx, body) => cancelHelp(ctx, body));
}

export async function commentOnHelpRequest(input: unknown): Promise<DeskResult> {
  return asParticipant(input, (ctx, body) => commentAsParticipant(ctx, body));
}

export async function rateHelpRequest(input: unknown): Promise<DeskResult> {
  return asParticipant(input, (ctx, body) => rateHelp(ctx, body));
}

export async function bookOfficeHourAction(input: unknown): Promise<DeskResult<{ id: string }>> {
  return asParticipant(input, (ctx, body) => bookOfficeHour(ctx, body));
}

export async function cancelOfficeHourBookingAction(input: unknown): Promise<DeskResult> {
  return asParticipant(input, (ctx, body) => cancelOfficeHourBooking(ctx, body));
}
