import { createHash } from "node:crypto";

/*
 * The seeded reviewer-assignment planner shared by judging
 * (lib/judgingAssignment.ts: judges and projects) and admission
 * (lib/admission/assignment: reviewers and applications). Pure and
 * deterministic, so the rules are unit tested without a database.
 *
 * Rules (the judging wording is in lib/judgingAssignment.ts):
 * - Every item should end up with `perItem` reviewers from the pool.
 * - A reviewer is never given an item they have a conflict with (`blocked`).
 * - "keep" leaves every existing assignment alone; a kept assignment counts
 *   towards the target when its reviewer may still review (`canReview`) and
 *   isn't blocked. "replace" removes existing assignments except where the
 *   reviewer already started (`started`); a remove-and-add of the same pair
 *   cancels out, so an unchanged input plans no changes.
 * - Started work without an assignment is adopted (`adoptStarted`) or, when
 *   submitted, counts towards the target.
 * - Load is balanced with a min-heap on each reviewer's load. Ties break on
 *   a hash of the reviewer and item ids (FNV-1a for BALANCED, the first 32
 *   bits of SHA-256(seed, value) for RANDOM), then the reviewer id, so the
 *   same input and seed always give the same plan.
 * - Items with the fewest possible reviewers go first; an item that can't
 *   reach the target is reported as a shortfall.
 */

export type AssignmentMode = "keep" | "replace";

export type PlannerPair = { reviewerId: string; itemId: string };

export type PlannerInput = {
  itemIds: readonly string[];
  poolReviewerIds: readonly string[];
  perItem: number;
  mode: AssignmentMode;
  existing: readonly PlannerPair[];
  blocked: ReadonlySet<string>;
  started: ReadonlySet<string>;
  submitted?: ReadonlySet<string>;
  adoptStarted?: boolean;
  canReview: (reviewerId: string) => boolean;
  /** RANDOM runs: 32 hex characters; null/undefined for BALANCED. */
  seed?: string | null;
};

export type PlannerLoad = { reviewerId: string; before: number; added: number; removed: number; after: number };
export type PlannerShortfall = { itemId: string; assigned: number; missing: number; possible: number };

export type PlannerPlan = {
  add: PlannerPair[];
  remove: PlannerPair[];
  adopt: PlannerPair[];
  loads: PlannerLoad[];
  shortfalls: PlannerShortfall[];
  covered: number;
  fingerprint: string;
};

export function pairKey(reviewerId: string, itemId: string): string {
  return `${reviewerId}\u0000${itemId}`;
}

/** 32-bit FNV-1a: a cheap, stable hash for tie-breaks (not a security boundary). */
export function tieHash(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** A seeded tie value for RANDOM runs: the first 32 bits of SHA-256(seed, value). Stable per seed. */
export function seededTie(seed: string, value: string): number {
  return createHash("sha256").update(seed).update("\u0000").update(value).digest().readUInt32BE(0);
}

/** A small binary min-heap with a caller-supplied ordering. */
export class MinHeap<T> {
  private readonly items: T[] = [];
  constructor(private readonly less: (a: T, b: T) => boolean) {}

  get size(): number {
    return this.items.length;
  }

  push(item: T): void {
    const items = this.items;
    items.push(item);
    let index = items.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (!this.less(items[index]!, items[parent]!)) break;
      [items[index], items[parent]] = [items[parent]!, items[index]!];
      index = parent;
    }
  }

  pop(): T | undefined {
    const items = this.items;
    if (items.length === 0) return undefined;
    const top = items[0];
    const last = items.pop()!;
    if (items.length > 0) {
      items[0] = last;
      let index = 0;
      for (;;) {
        const left = index * 2 + 1;
        const right = left + 1;
        let smallest = index;
        if (left < items.length && this.less(items[left]!, items[smallest]!)) smallest = left;
        if (right < items.length && this.less(items[right]!, items[smallest]!)) smallest = right;
        if (smallest === index) break;
        [items[index], items[smallest]] = [items[smallest]!, items[index]!];
        index = smallest;
      }
    }
    return top;
  }
}

function comparePairs(a: PlannerPair, b: PlannerPair) {
  return a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : a.reviewerId < b.reviewerId ? -1 : a.reviewerId > b.reviewerId ? 1 : 0;
}

export function plannerFingerprint(
  add: readonly PlannerPair[],
  remove: readonly PlannerPair[],
  perItem: number,
  mode: AssignmentMode,
  adopt: readonly PlannerPair[] = [],
  seed: string | null = null,
): string {
  const hash = createHash("sha256");
  hash.update(`${mode}:${perItem}\n`);
  if (seed) hash.update(`seed:${seed}\n`);
  for (const pair of [...add].sort(comparePairs)) hash.update(`+${pair.reviewerId}:${pair.itemId}\n`);
  for (const pair of [...remove].sort(comparePairs)) hash.update(`-${pair.reviewerId}:${pair.itemId}\n`);
  for (const pair of [...adopt].sort(comparePairs)) hash.update(`=${pair.reviewerId}:${pair.itemId}\n`);
  return hash.digest("base64url").slice(0, 22);
}

type Candidate = { reviewerId: string; load: number; tie: number };

/** Build the assignment plan. Pure and deterministic: the same input gives the same plan. */
export function planAssignments(input: PlannerInput): PlannerPlan {
  const perItem = Math.max(1, Math.floor(input.perItem));
  const seed = input.seed ?? null;
  const tie = seed ? (value: string) => seededTie(seed, value) : tieHash;
  const pool = [...new Set(input.poolReviewerIds)];
  const items = [...new Set(input.itemIds)].sort();
  const itemSet = new Set(items);

  const kept: PlannerPair[] = [];
  let remove: PlannerPair[] = [];
  for (const pair of input.existing) {
    if (!itemSet.has(pair.itemId)) continue;
    if (input.mode === "replace" && !input.started.has(pairKey(pair.reviewerId, pair.itemId))) remove.push(pair);
    else kept.push(pair);
  }

  const load = new Map<string, number>(pool.map((id) => [id, 0]));
  const assignedTo = new Map<string, Set<string>>(items.map((id) => [id, new Set<string>()]));
  const counted = new Map<string, number>(items.map((id) => [id, 0]));
  for (const pair of kept) {
    assignedTo.get(pair.itemId)!.add(pair.reviewerId);
    if (load.has(pair.reviewerId)) load.set(pair.reviewerId, load.get(pair.reviewerId)! + 1);
    if (input.canReview(pair.reviewerId) && !input.blocked.has(pairKey(pair.reviewerId, pair.itemId))) {
      counted.set(pair.itemId, counted.get(pair.itemId)! + 1);
    }
  }
  const before = new Map<string, number>(pool.map((id) => [id, 0]));
  for (const pair of input.existing) {
    if (!itemSet.has(pair.itemId) || !before.has(pair.reviewerId)) continue;
    before.set(pair.reviewerId, before.get(pair.reviewerId)! + 1);
  }

  // Work done without an assignment row.
  const existingKeys = new Set(input.existing.filter((pair) => itemSet.has(pair.itemId)).map((pair) => pairKey(pair.reviewerId, pair.itemId)));
  const adopt: PlannerPair[] = [];
  for (const key of [...input.started].sort()) {
    if (existingKeys.has(key) || input.blocked.has(key)) continue;
    const [reviewerId, itemId] = key.split("\u0000") as [string, string];
    if (!itemSet.has(itemId) || !input.canReview(reviewerId)) continue;
    if (input.adoptStarted) {
      adopt.push({ reviewerId, itemId });
      assignedTo.get(itemId)!.add(reviewerId);
      counted.set(itemId, counted.get(itemId)! + 1);
      if (load.has(reviewerId)) {
        load.set(reviewerId, load.get(reviewerId)! + 1);
        before.set(reviewerId, before.get(reviewerId)! + 1);
      }
    } else if (input.submitted?.has(key)) {
      assignedTo.get(itemId)!.add(reviewerId);
      counted.set(itemId, counted.get(itemId)! + 1);
    }
  }

  // Who could still take each item; the most constrained items go first.
  const possible = new Map<string, string[]>();
  for (const itemId of items) {
    const taken = assignedTo.get(itemId)!;
    possible.set(itemId, pool.filter((reviewerId) => !taken.has(reviewerId) && !input.blocked.has(pairKey(reviewerId, itemId))));
  }
  const order = items
    .map((id) => ({ id, room: possible.get(id)!.length + counted.get(id)!, tie: tie(id) }))
    .sort((a, b) => a.room - b.room || a.tie - b.tie || (a.id < b.id ? -1 : 1));

  let add: PlannerPair[] = [];
  const shortfalls: PlannerShortfall[] = [];
  let covered = 0;
  for (const { id: itemId } of order) {
    let have = counted.get(itemId)!;
    const need = perItem - have;
    if (need > 0) {
      const heap = new MinHeap<Candidate>((a, b) => a.load < b.load || (a.load === b.load && (a.tie < b.tie || (a.tie === b.tie && a.reviewerId < b.reviewerId))));
      for (const reviewerId of possible.get(itemId)!) {
        heap.push({ reviewerId, load: load.get(reviewerId)!, tie: tie(pairKey(reviewerId, itemId)) });
      }
      for (let picked = 0; picked < need && heap.size > 0; picked += 1) {
        const next = heap.pop()!;
        add.push({ reviewerId: next.reviewerId, itemId });
        load.set(next.reviewerId, load.get(next.reviewerId)! + 1);
        have += 1;
      }
    }
    if (have >= perItem) covered += 1;
    else shortfalls.push({ itemId, assigned: have, missing: perItem - have, possible: possible.get(itemId)!.length + counted.get(itemId)! });
  }

  // Replace mode: an assignment removed and picked straight back is simply kept.
  if (remove.length && add.length) {
    const addKeys = new Set(add.map((pair) => pairKey(pair.reviewerId, pair.itemId)));
    const removeKeys = new Set(remove.map((pair) => pairKey(pair.reviewerId, pair.itemId)));
    const both = (pair: PlannerPair) => addKeys.has(pairKey(pair.reviewerId, pair.itemId)) && removeKeys.has(pairKey(pair.reviewerId, pair.itemId));
    add = add.filter((pair) => !both(pair));
    remove = remove.filter((pair) => !both(pair));
  }
  const removedBy = new Map<string, number>();
  for (const pair of remove) removedBy.set(pair.reviewerId, (removedBy.get(pair.reviewerId) ?? 0) + 1);

  const added = new Map<string, number>();
  for (const pair of add) added.set(pair.reviewerId, (added.get(pair.reviewerId) ?? 0) + 1);
  const loads = pool.map((reviewerId) => ({
    reviewerId,
    before: before.get(reviewerId)!,
    added: added.get(reviewerId) ?? 0,
    removed: removedBy.get(reviewerId) ?? 0,
    after: load.get(reviewerId)!,
  }));
  shortfalls.sort((a, b) => b.missing - a.missing || (a.itemId < b.itemId ? -1 : 1));
  add.sort(comparePairs);
  remove.sort(comparePairs);
  adopt.sort(comparePairs);
  return { add, remove, adopt, loads, shortfalls, covered, fingerprint: plannerFingerprint(add, remove, perItem, input.mode, adopt, seed) };
}
