import "server-only";

/*
 * Gates for the Mentor Desk Server Actions (app/actions/mentor-*.ts):
 * authentication, rate limiting, then the server-side context (organiser,
 * mentor or participant). The cores re-check everything inside their own
 * transaction. No "use server" here: these helpers are not actions.
 */

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { isActionRateLimited } from "@/lib/actionRateLimit";
import { resolveDeskOrganiser, resolveMentorContext, resolveParticipantByManageToken, resolveParticipantForUser, type DeskOrganiserContext, type MentorContext, type ParticipantContext } from "@/lib/core/mentorDesk/access";
import type { DeskResult } from "@/lib/core/mentorDesk/shared";
import { hashTeamManageToken } from "@/lib/teamToken";

const scopeSchema = z.object({ organisationSlug: z.string().trim().min(1).max(128), eventId: z.string().trim().min(1).max(128) });

type Fields = Record<string, unknown>;

function fields(input: unknown): Fields {
  return typeof input === "object" && input !== null && !Array.isArray(input) ? (input as Fields) : {};
}

/** The command's own fields, without the routing scope. */
function body(input: Fields): Fields {
  const { organisationSlug: _o, eventId: _e, manageToken: _t, ...rest } = input;
  void _o; void _e; void _t;
  return rest;
}

const TOO_MANY = "Too many requests. Try again shortly.";

async function signedIn(bucket: "action" | "search" = "action") {
  const userId = (await auth())?.user?.id;
  if (!userId) return { ok: false as const, error: "You must be signed in." };
  if (await isActionRateLimited(bucket, userId)) return { ok: false as const, error: TOO_MANY };
  return { ok: true as const, userId };
}

function revalidateDesk(orgSlug: string, eventId: string) {
  revalidatePath(`/dashboard/${orgSlug}/event/${eventId}`);
}

/** Organisation OWNER/ADMIN of the event (resolveDeskOrganiser). */
export async function asOrganiser<T>(input: unknown, run: (ctx: DeskOrganiserContext, body: Fields) => Promise<DeskResult<T>>): Promise<DeskResult<T>> {
  const f = fields(input);
  const scope = scopeSchema.safeParse(f);
  if (!scope.success) return { ok: false, error: "Invalid input." };
  const user = await signedIn();
  if (!user.ok) return user;
  const ctx = await resolveDeskOrganiser(user.userId, scope.data.organisationSlug, scope.data.eventId);
  if (!ctx) return { ok: false, error: "You do not have permission to manage the Mentor Desk for this event." };
  const result = await run(ctx, body(f));
  if (result.ok) revalidateDesk(ctx.orgSlug, ctx.eventId);
  return result;
}

/** A MENTOR grant holder past the staff authenticator check, on an event with the desk on. */
export async function asMentor<T>(input: unknown, run: (ctx: MentorContext, body: Fields) => Promise<DeskResult<T>>): Promise<DeskResult<T>> {
  const f = fields(input);
  const scope = scopeSchema.safeParse(f);
  if (!scope.success) return { ok: false, error: "Invalid input." };
  const user = await signedIn();
  if (!user.ok) return user;
  const ctx = await resolveMentorContext(user.userId, scope.data.organisationSlug, scope.data.eventId);
  if (!ctx) return { ok: false, error: "You are not a mentor on this event." };
  const result = await run(ctx, body(f));
  if (result.ok) revalidateDesk(ctx.orgSlug, ctx.eventId);
  return result;
}

/**
 * A participant: the team's management link (`manageToken`), or the signed-in
 * owner of a CONFIRMED registration (`organisationSlug` + `eventId`). A ticket
 * link alone is never enough.
 */
export async function asParticipant<T>(input: unknown, run: (ctx: ParticipantContext, body: Fields) => Promise<DeskResult<T>>): Promise<DeskResult<T>> {
  const f = fields(input);
  let ctx: ParticipantContext | null = null;
  if (typeof f.manageToken === "string") {
    if (await isActionRateLimited("action", hashTeamManageToken(f.manageToken.slice(0, 200)))) return { ok: false, error: TOO_MANY };
    ctx = await resolveParticipantByManageToken(f.manageToken);
  } else {
    const scope = scopeSchema.safeParse(f);
    if (!scope.success) return { ok: false, error: "Invalid input." };
    const user = await signedIn();
    if (!user.ok) return user;
    ctx = await resolveParticipantForUser(user.userId, scope.data.organisationSlug, scope.data.eventId);
  }
  if (!ctx) return { ok: false, error: "Not found." };
  const result = await run(ctx, body(f));
  if (result.ok) revalidatePath(`/account/mentoring/${ctx.eventId}`);
  return result;
}
