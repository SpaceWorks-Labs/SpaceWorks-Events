import { EventPrivacyType, Prisma, RegistrationMode, RsvpStatus, SoloPolicy } from "@prisma/client";
import { teamNameKey, type TeamRegistrationIntent } from "@/lib/validators";
import { countConfirmedUnits, teamPlacesTaken } from "@/lib/teamUnits";
import { generateTeamManageToken, generateTeamToken } from "@/lib/teamToken";
import { decideRsvpStatus } from "./reserve";

export const LEADER_STILL_PAYING = "This team's leader is still paying for it. Try the link again in a few minutes.";

/** A team rule refused the registration; the message is safe to show. */
export class TeamRegistrationError extends Error {
  constructor(message: string, readonly code?: "TEAM_REQUIRED") {
    super(message);
  }
}

export function teamRegistrationFailure(error: TeamRegistrationError): { ok: false; error: string; code?: "TEAM_REQUIRED" } {
  return error.code ? { ok: false, error: error.message, code: error.code } : { ok: false, error: error.message };
}

export function isUniqueViolationOn(error: unknown, column: string) {
  if (typeof error !== "object" || error === null || (error as { code?: string }).code !== "P2002") return false;
  const target = (error as { meta?: { target?: unknown } }).meta?.target;
  return Array.isArray(target) ? target.includes(column) : typeof target === "string" && target.includes(column);
}

export type TeamEventSettings = { registrationMode: RegistrationMode; teamMaxSize: number | null; soloPolicy: SoloPolicy };

/**
 * Decides where a registration on a TEAM event goes (docs/TEAMS.md): solo,
 * a new team, or an existing team by its join link. Runs under the Event row
 * lock the caller already holds, so capacity counts units without overselling.
 */
export async function placeTeamRegistration(tx: Prisma.TransactionClient, params: {
  eventId: string;
  capacity: number | null;
  privacyType: EventPrivacyType;
  settings: TeamEventSettings;
  intent: TeamRegistrationIntent | undefined;
  allowSoloWithoutTeam?: boolean;
}): Promise<{ status: RsvpStatus; team: { id: string; name: string; } | null; newTeamManageToken: string | null; }> {
  const { eventId, capacity, privacyType, settings, intent } = params;
  if (!intent || intent.mode === "solo") {
    if (settings.soloPolicy === SoloPolicy.TEAMS_ONLY && !params.allowSoloWithoutTeam) {
      throw new TeamRegistrationError("This event registers teams only. Create a team or join one with a team link.", "TEAM_REQUIRED");
    }
    return { status: decideRsvpStatus({ capacity, confirmedCount: await countConfirmedUnits(tx, eventId), privacyType }), team: null, newTeamManageToken: null };
  }
  if (intent.mode === "create") {
    const nameKey = teamNameKey(intent.name);
    const taken = await tx.team.findUnique({ where: { eventId_nameKey: { eventId, nameKey } }, select: { id: true } });
    if (taken) throw new TeamRegistrationError("That team name is already taken for this event.");
    const status = decideRsvpStatus({ capacity, confirmedCount: await countConfirmedUnits(tx, eventId), privacyType });
    const manage = generateTeamManageToken();
    const team = await tx.team.create({
      data: { eventId, name: intent.name, nameKey, status, joinToken: generateTeamToken(), manageTokenHash: manage.hash },
      select: { id: true, name: true },
    });
    return { status, team, newTeamManageToken: manage.raw };
  }
  const joined = await tx.team.findFirst({ where: { joinToken: intent.joinToken, eventId }, select: { id: true, name: true, status: true } });
  if (!joined) throw new TeamRegistrationError("This team link is no longer valid. Ask your team leader for a new one.");
  if (joined.status === RsvpStatus.REJECTED) throw new TeamRegistrationError("This team can no longer be joined.");
  if (joined.status === RsvpStatus.PENDING_PAYMENT) throw new TeamRegistrationError(LEADER_STILL_PAYING);
  const size = await teamPlacesTaken(tx, joined.id);
  if (settings.teamMaxSize == null || size >= settings.teamMaxSize) throw new TeamRegistrationError("This team is already full.");
  // Joining never changes capacity: the member takes the team's status.
  return { status: joined.status, team: { id: joined.id, name: joined.name }, newTeamManageToken: null };
}
