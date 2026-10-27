import "server-only";

import {
  checkInByRsvpId, checkInByToken, downloadOfflineCheckInRoster, loadRecentCheckIns, lookupAttendeesForCheckIn,
  previewCheckInByRsvpId, previewCheckInByToken, syncOfflineCheckIns, undoCheckIn,
} from "@/app/actions/checkin";
import { currentRequestActor, runAsRequestActor } from "@/lib/requestActor";
import { forUser } from "./actor";

export type { CheckInPreviewData, CheckInResultData, LookupRow, OfflineCheckInRosterRow } from "@/app/actions/checkin";

/*
 * Check-in for API callers, by the desk's own action bodies: the same status
 * gate (a PENDING_PAYMENT ticket is refused), commitCheckInProjection with the
 * live ticket update, webhooks and audit. A mobile check-in is recorded with
 * its source ("mobile-scan" or "mobile-manual").
 */
export type CheckInCoreOptions = { source?: "online" | "mobile-scan" | "mobile-manual"; };

function withSource<T>(actorUserId: string | null, options: CheckInCoreOptions, run: () => Promise<T>) {
  return forUser(actorUserId, () => {
    const actor = currentRequestActor()!;
    const source = options.source === "mobile-scan" || options.source === "mobile-manual" ? options.source : undefined;
    return source ? runAsRequestActor({ ...actor, checkInSource: source }, run) : run();
  });
}

export const previewCheckInByTokenForUser = (actorUserId: string | null, input: unknown) => forUser(actorUserId, () => previewCheckInByToken(input));
export const previewCheckInByRsvpIdForUser = (actorUserId: string | null, input: unknown) => forUser(actorUserId, () => previewCheckInByRsvpId(input));
export const checkInByTokenForUser = (actorUserId: string | null, input: unknown, options: CheckInCoreOptions = {}) => withSource(actorUserId, options, () => checkInByToken(input));
export const checkInByRsvpIdForUser = (actorUserId: string | null, input: unknown, options: CheckInCoreOptions = {}) => withSource(actorUserId, options, () => checkInByRsvpId(input));
export const undoCheckInForUser = (actorUserId: string | null, input: unknown, options: CheckInCoreOptions = {}) => withSource(actorUserId, options, () => undoCheckIn(input));
export const lookupAttendeesForCheckInForUser = (actorUserId: string | null, input: unknown) => forUser(actorUserId, () => lookupAttendeesForCheckIn(input));
export const downloadOfflineCheckInRosterForUser = (actorUserId: string | null, input: unknown) => forUser(actorUserId, () => downloadOfflineCheckInRoster(input));
export const syncOfflineCheckInsForUser = (actorUserId: string | null, input: unknown) => forUser(actorUserId, () => syncOfflineCheckIns(input));
export const loadRecentCheckInsForUser = (actorUserId: string | null, input: unknown) => forUser(actorUserId, () => loadRecentCheckIns(input));
