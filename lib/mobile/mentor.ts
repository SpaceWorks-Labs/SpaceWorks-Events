import "server-only";

import { resolveDeskOrganiser, resolveMentorContext, resolveParticipantForUser, type DeskOrganiserContext, type MentorContext, type ParticipantContext } from "@/lib/core/mentorDesk/access";
import type { DeskResult } from "@/lib/core/mentorDesk/shared";
import { idempotentWrite } from "@/lib/mobile/idempotency";
import { mobileActionError, mobileError, mobileOk } from "@/lib/mobile/http";
import { resolveEventContext } from "@/lib/mobile/organiser";
import { authedMobileRoute, type AuthedRouteContext } from "@/lib/mobile/route";
import { deskWriteDtoSchema } from "@/lib/mobile/schemas";

/*
 * Mentor Desk routes for the app (docs/MENTOR_DESK.md). Reads use the web's
 * own read models; every write runs the matching Server Action body as the
 * request actor, so the cores re-check the grant, the version and the
 * mentor's window inside their transaction. Writes need an Idempotency-Key.
 * Help text is never logged: failures log the route name only.
 */

type Scope = { orgSlug: string; eventId: string };
type Fields = Record<string, unknown>;

/** Fields a body may never set: the routing scope and the participant's team link come from the path and the session. */
const RESERVED = new Set(["organisationSlug", "eventId", "manageToken", "mentorUserId"]);

function bodyFields(value: unknown, allow: readonly string[]): Fields {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Fields).filter(([key]) => !RESERVED.has(key) || allow.includes(key)));
}

function deskAnswer<T>(result: DeskResult<T>, status = 200) {
  if (!result.ok) return mobileActionError(result);
  const data = result.data && typeof result.data === "object" ? result.data : null;
  return mobileOk(deskWriteDtoSchema.parse(data), status);
}

/**
 * One idempotent desk write: the body (minus reserved fields) plus `extra`
 * from the path, scoped to the event in the path, through `action`.
 */
export function deskWrite<T>(
  request: Request,
  context: AuthedRouteContext,
  routeId: string,
  scope: Scope,
  action: (input: unknown) => Promise<DeskResult<T>>,
  extra: Fields = {},
  status = 200,
  /** Reserved body fields this route may take (an organiser naming the mentor to assign). */
  allow: readonly string[] = [],
) {
  return idempotentWrite(request, context.auth.userId, routeId, async (body) => {
    const result = await action({ ...bodyFields(body, allow), ...extra, organisationSlug: scope.orgSlug, eventId: scope.eventId });
    return deskAnswer(result, status);
  });
}

/** Signed-in owner of a CONFIRMED registration on the event (or a member of its team); never a ticket link alone. */
export function participantRoute<P extends Scope>(
  routeId: string,
  handler: (request: Request, params: P, context: AuthedRouteContext & { participant: ParticipantContext }) => Promise<Response>,
) {
  return authedMobileRoute<P>(routeId, async (request, params, context) => {
    const participant = await resolveParticipantForUser(context.auth.userId, params.orgSlug, params.eventId);
    if (!participant) return mobileError("NOT_FOUND");
    return handler(request, params, { ...context, participant });
  });
}

/**
 * The mentor console: a MENTOR grant on an event with the desk on, past the
 * staff authenticator check (a mentor-only app session needs a fresh code).
 * An event the caller can see as an organiser without the grant is FORBIDDEN.
 */
export function mentorRoute<P extends Scope>(
  routeId: string,
  handler: (request: Request, params: P, context: AuthedRouteContext & { mentor: MentorContext }) => Promise<Response>,
) {
  return authedMobileRoute<P>(routeId, async (request, params, context) => {
    const mentor = await resolveMentorContext(context.auth.userId, params.orgSlug, params.eventId);
    if (!mentor) return mobileError((await resolveEventContext(context.auth.userId, params.orgSlug, params.eventId)) ? "FORBIDDEN" : "NOT_FOUND");
    return handler(request, params, { ...context, mentor });
  }, { staff: true });
}

/** Organisation OWNER/ADMIN of the event (the web's Mentor Desk tab). */
export function deskOrganiserRoute<P extends Scope>(
  routeId: string,
  handler: (request: Request, params: P, context: AuthedRouteContext & { organiser: DeskOrganiserContext }) => Promise<Response>,
) {
  return authedMobileRoute<P>(routeId, async (request, params, context) => {
    const organiser = await resolveDeskOrganiser(context.auth.userId, params.orgSlug, params.eventId);
    if (!organiser) return mobileError((await resolveEventContext(context.auth.userId, params.orgSlug, params.eventId)) ? "FORBIDDEN" : "NOT_FOUND");
    return handler(request, params, { ...context, organiser });
  }, { staff: true });
}
