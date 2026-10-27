import "server-only";

/*
 * The inputs of a mentor-team allocation (assignment_workflow.preview), read
 * in one place so the preview and the apply see exactly the same thing. The
 * fingerprint of these inputs is stored on the run; an apply whose inputs no
 * longer match the preview is refused as stale.
 */

import { createHash } from "node:crypto";
import { EventPermission, MentorAssignmentStatus, Prisma, RsvpStatus } from "@prisma/client";
import { normaliseTags } from "@/lib/mentorDesk/rules";
import type { AllocationCandidate, AllocationMode, AllocationTeam } from "@/lib/mentorDesk/allocation";
import { COPY, refuse } from "./shared";

export type AssignmentScope = { eventId: string; roundId: string | null };

export type AllocationInputs = { teams: AllocationTeam[]; candidates: AllocationCandidate[]; names: Map<string, string>; teamNames: Map<string, string> };

/** The round (scope), its pool and the earlier rounds whose teams count for fresh eyes. */
async function roundScope(tx: Prisma.TransactionClient, scope: AssignmentScope) {
  if (!scope.roundId) return null;
  const round = await tx.mentoringRound.findFirst({ where: { id: scope.roundId, eventId: scope.eventId }, select: { id: true, position: true, freshEyesAcrossStages: true, mentors: { select: { mentorUserId: true } } } });
  if (!round) refuse(COPY.notFound);
  const earlier = await tx.mentoringRound.findMany({ where: { eventId: scope.eventId, position: { lt: round.position } }, select: { id: true } });
  return { ...round, pool: new Set(round.mentors.map((m) => m.mentorUserId)), earlierIds: earlier.map((r) => r.id) };
}

/** Live mappings that count against a mentor's capacity in this scope. */
function loadWhere(scope: AssignmentScope): Prisma.MentorTeamAssignmentWhereInput {
  return { eventId: scope.eventId, endedAt: null, ...(scope.roundId ? { OR: [{ roundId: null }, { roundId: scope.roundId }] } : {}) };
}

/** `ignoreAssignmentId`: a PROPOSED mapping being activated does not count against itself. */
export async function readAllocationInputs(tx: Prisma.TransactionClient, scope: AssignmentScope, teamFilter?: readonly string[], ignoreAssignmentId?: string): Promise<AllocationInputs> {
  const round = await roundScope(tx, scope);
  const grants = await tx.eventCollaborator.findMany({
    where: { eventId: scope.eventId, permissions: { has: EventPermission.MENTOR } },
    select: { userId: true, user: { select: { name: true, mentorProfiles: { where: { eventId: scope.eventId }, select: { skills: true, maxActiveTeams: true } } } } },
  });
  // A round with a pool uses only that pool; no rows means every eligible mentor.
  const mentors = grants.filter((g) => g.user.mentorProfiles.length > 0 && (!round || round.pool.size === 0 || round.pool.has(g.userId)));
  const mentorIds = mentors.map((m) => m.userId);
  const teams = await tx.team.findMany({
    where: { eventId: scope.eventId, status: RsvpStatus.CONFIRMED, ...(teamFilter ? { id: { in: [...teamFilter] } } : {}) },
    select: { id: true, name: true, members: { select: { userId: true, seekerProfile: { select: { skills: true } } } }, helpRequests: { select: { category: { select: { skillTags: true } } } } },
    orderBy: { id: "asc" },
  });
  const [conflicts, live, loads, earlier] = await Promise.all([
    tx.mentorConflict.findMany({ where: { eventId: scope.eventId, active: true, mentorUserId: { in: mentorIds } }, select: { mentorUserId: true, teamId: true } }),
    tx.mentorTeamAssignment.findMany({ where: { eventId: scope.eventId, endedAt: null, roundId: scope.roundId, mentorUserId: { in: mentorIds }, ...(ignoreAssignmentId ? { id: { not: ignoreAssignmentId } } : {}) }, select: { mentorUserId: true, teamId: true } }),
    tx.mentorTeamAssignment.groupBy({ by: ["mentorUserId"], where: { ...loadWhere(scope), mentorUserId: { in: mentorIds }, ...(ignoreAssignmentId ? { id: { not: ignoreAssignmentId } } : {}) }, _count: { _all: true } }),
    round && round.earlierIds.length
      ? Promise.all([
        tx.mentorTeamAssignment.findMany({ where: { roundId: { in: round.earlierIds }, status: { in: [MentorAssignmentStatus.ACTIVE, MentorAssignmentStatus.ENDED] } }, select: { mentorUserId: true, teamId: true } }),
        tx.mentoringCheckIn.findMany({ where: { roundId: { in: round.earlierIds } }, select: { mentorUserId: true, teamId: true } }),
      ]).then(([a, b]) => [...a, ...b])
      : Promise.resolve([] as Array<{ mentorUserId: string; teamId: string }>),
  ]);
  const group = (rows: Array<{ mentorUserId: string; teamId: string }>) => {
    const map = new Map<string, Set<string>>();
    for (const row of rows) map.set(row.mentorUserId, (map.get(row.mentorUserId) ?? new Set()).add(row.teamId));
    return map;
  };
  const conflicted = group(conflicts);
  const mapped = group(live);
  const mentoredBefore = group(earlier);
  const loadBy = new Map(loads.map((row) => [row.mentorUserId, row._count._all]));
  const candidates: AllocationCandidate[] = mentors.map((m) => {
    const excluded = new Set<string>([...(conflicted.get(m.userId) ?? []), ...(mapped.get(m.userId) ?? [])]);
    for (const team of teams) if (team.members.some((member) => member.userId === m.userId)) excluded.add(team.id);
    const before = mentoredBefore.get(m.userId) ?? new Set<string>();
    if (round?.freshEyesAcrossStages) for (const id of before) excluded.add(id);
    const profile = m.user.mentorProfiles[0]!;
    return { id: m.userId, skills: profile.skills, load: loadBy.get(m.userId) ?? 0, capacity: profile.maxActiveTeams, excludedTeamIds: excluded, avoidTeamIds: before };
  });
  return {
    teams: teams.map((team) => ({
      id: team.id,
      // A team's skills: its members' "looking for a team" skills and the skill tags of the help it asked for.
      skills: normaliseTags([...team.members.flatMap((m) => m.seekerProfile?.skills ?? []), ...team.helpRequests.flatMap((r) => r.category.skillTags)]),
    })),
    candidates,
    names: new Map(mentors.map((m) => [m.userId, m.user.name?.trim() || "Mentor"])),
    teamNames: new Map(teams.map((t) => [t.id, t.name])),
  };
}

/** A stable digest of everything the allocation depends on. */
export function inputFingerprint(params: { mode: AllocationMode; scope: AssignmentScope; inputs: AllocationInputs; manual?: Readonly<Record<string, string>> }): string {
  const canonical = {
    mode: params.mode,
    roundId: params.scope.roundId,
    teams: params.inputs.teams.map((t) => [t.id, [...t.skills].sort()]),
    candidates: [...params.inputs.candidates].sort((a, b) => (a.id < b.id ? -1 : 1)).map((c) => [c.id, [...c.skills].sort(), c.load, c.capacity, [...c.excludedTeamIds].sort(), [...(c.avoidTeamIds ?? [])].sort()]),
    manual: Object.entries(params.manual ?? {}).sort(),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}
