/*
 * Mentor-team allocation (docs/MENTOR_DESK.md), ported from the Space Works
 * assignment_workflow.allocate: deterministic and pure. Preview and apply run
 * the same function; the apply re-reads every input under the event lock.
 *
 * Modes:
 * - MANUAL: the organiser's choice per team, if still eligible.
 * - ROUND_ROBIN: lowest load first, then id.
 * - SKILL_MATCH: highest skill overlap first, then lowest load, then id.
 * - RANDOM (a Space Works Events extension): a seeded shuffle of the mentors,
 *   then lowest load first, so a seed always gives the same result and a new
 *   seed ("re-roll") a different one. Conflicts and capacity still apply.
 *
 * Teams are visited in id order. A candidate never takes a team it is
 * excluded from (team membership, a declared or affiliation conflict, an
 * existing live mapping, or a team it mentored in an earlier round when the
 * round's fresh-eyes rule is on) nor goes over its capacity. In SKILL_MATCH
 * and RANDOM a team mentored in an earlier round is avoided where possible.
 */

export type AllocationMode = "MANUAL" | "ROUND_ROBIN" | "SKILL_MATCH" | "RANDOM";

export type AllocationCandidate = {
  id: string;
  skills: readonly string[];
  load: number;
  capacity: number;
  excludedTeamIds: ReadonlySet<string>;
  /** Teams mentored in an earlier round: a soft preference against in SKILL_MATCH and RANDOM. */
  avoidTeamIds?: ReadonlySet<string>;
};

export type AllocationTeam = { id: string; skills: readonly string[] };

export type AllocationDecision = { teamId: string; mentorUserId: string };

export type AllocationResult = { assignments: AllocationDecision[]; uncoveredTeamIds: string[] };

const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** xmur3 string hash: a 32-bit seed stream from any string. */
function hashSeed(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i += 1) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
}

/** sfc32: a small, well-distributed PRNG; the same seed gives the same sequence on every runtime. */
export function seededRandom(seed: string): () => number {
  const next = hashSeed(seed);
  let a = next(), b = next(), c = next(), d = next();
  return () => {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

/** Fisher-Yates over a stably sorted copy. */
export function seededShuffle<T extends { id: string }>(items: readonly T[], seed: string): T[] {
  const random = seededRandom(seed);
  const result = [...items].sort(byId);
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}

export function allocate(params: {
  teams: readonly AllocationTeam[];
  candidates: readonly AllocationCandidate[];
  mode: AllocationMode;
  /** MANUAL: team id to mentor user id. */
  manual?: Readonly<Record<string, string>>;
  /** RANDOM: the run's seed. */
  seed?: string;
  skillWeights?: Readonly<Record<string, number>>;
}): AllocationResult {
  const { mode } = params;
  if (mode === "RANDOM" && !params.seed) throw new Error("RANDOM allocation needs a seed.");
  const candidates = [...params.candidates].sort(byId);
  const rank = new Map((mode === "RANDOM" ? seededShuffle(candidates, params.seed!) : candidates).map((c, index) => [c.id, index]));
  const loads = new Map(candidates.map((c) => [c.id, c.load]));
  const weights = params.skillWeights ?? {};
  const assignments: AllocationDecision[] = [];
  const uncoveredTeamIds: string[] = [];
  for (const team of [...params.teams].sort(byId)) {
    let eligible = candidates.filter((c) => !c.excludedTeamIds.has(team.id) && loads.get(c.id)! < c.capacity);
    if (mode === "MANUAL") eligible = eligible.filter((c) => c.id === params.manual?.[team.id]);
    if (eligible.length === 0) {
      uncoveredTeamIds.push(team.id);
      continue;
    }
    const teamSkills = new Set(team.skills);
    const key = (c: AllocationCandidate): number[] => {
      const load = loads.get(c.id)!;
      const soft = (mode === "SKILL_MATCH" || mode === "RANDOM") && c.avoidTeamIds?.has(team.id) ? 1 : 0;
      if (mode === "SKILL_MATCH") {
        const score = c.skills.reduce((sum, skill) => sum + (teamSkills.has(skill) ? weights[skill] ?? 1 : 0), 0);
        return [-score, soft, load, rank.get(c.id)!];
      }
      return [soft, load, rank.get(c.id)!];
    };
    const winner = eligible.reduce((best, c) => {
      const a = key(c);
      const b = key(best);
      for (let i = 0; i < a.length; i += 1) {
        if (a[i]! !== b[i]!) return a[i]! < b[i]! ? c : best;
      }
      return best;
    });
    assignments.push({ teamId: team.id, mentorUserId: winner.id });
    loads.set(winner.id, loads.get(winner.id)! + 1);
  }
  return { assignments, uncoveredTeamIds };
}
