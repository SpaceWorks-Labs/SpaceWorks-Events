import { z } from "zod";
import { iso } from "./core";

/*
 * Mentor Desk DTOs (docs/MENTOR_DESK.md). Help text reaches only the people
 * the web shows it to: the team that raised it, and mentors who may see it.
 * Never emails, registration answers, ticket links or team links. A mentor's
 * own claim and visit lease ids are returned to that mentor only, because
 * every command must name them.
 */

const helpStatus = z.enum(["OPEN", "CLAIMED", "RESOLVED", "CANCELLED", "EXPIRED"]);
const comment = z.object({ id: z.string(), origin: z.string(), body: z.string(), createdAt: iso }).strict();
const localTime = z.string();

/* ---------- Participants ---------- */

export const participantHelpSchema = z.object({
  id: z.string(),
  version: z.number().int(),
  status: helpStatus,
  category: z.string(),
  summary: z.string(),
  location: z.string(),
  rating: z.number().int().nullable(),
  createdAt: iso,
  deadline: iso,
  open: z.boolean(),
  comments: z.array(comment),
}).strict();

export const participantDeskDtoSchema = z.object({
  timezone: z.string(),
  isTeam: z.boolean(),
  categories: z.array(z.object({ key: z.string(), label: z.string(), contactNote: z.string() }).strict()),
  requests: z.array(participantHelpSchema),
  mentors: z.array(z.object({ id: z.string(), name: z.string(), bio: z.string(), skills: z.array(z.string()) }).strict()),
  slots: z.array(z.object({ id: z.string(), version: z.number().int(), startsAt: iso, endsAt: iso, location: z.string(), mentorName: z.string(), placesLeft: z.number().int() }).strict()),
  bookings: z.array(z.object({ id: z.string(), startsAt: iso, endsAt: iso, location: z.string(), mentorName: z.string(), started: z.boolean() }).strict()),
}).strict();

/** The answer to a Mentor Desk write: the new record's id where one is made. */
export const deskWriteDtoSchema = z.object({ id: z.string().optional(), leaseId: z.string().optional(), generation: z.number().int().optional(), checkInId: z.string().optional() }).strict().nullable();

/* ---------- Mentors ---------- */

export const mentorQueueItemSchema = z.object({
  id: z.string(),
  version: z.number().int(),
  category: z.string(),
  priority: z.number().int(),
  summary: z.string(),
  location: z.string(),
  who: z.string(),
  assignedToMe: z.boolean(),
  eligible: z.boolean(),
  deadline: iso,
  createdAt: iso,
}).strict();

export const mentorQueueDtoSchema = z.object({ requests: z.array(mentorQueueItemSchema), nextCursor: z.string().nullable() }).strict();

export const mentorConsoleDtoSchema = z.object({
  timezone: z.string(),
  onShift: z.boolean(),
  profile: z.object({
    version: z.number().int(), skills: z.array(z.string()), bio: z.string(), affiliation: z.string(), maxActiveTeams: z.number().int(), showOnPage: z.boolean(),
    availability: z.array(z.object({ start: localTime, end: localTime }).strict()), eventStart: localTime, eventEnd: localTime,
  }).strict(),
  /** The request this mentor holds now, with its comments. */
  claim: z.object({
    id: z.string(), version: z.number().int(), claimId: z.string(), claimGeneration: z.number().int(), claimExpiresAt: iso, lapsed: z.boolean(),
    category: z.string(), summary: z.string(), location: z.string(), who: z.string(), comments: z.array(comment),
  }).strict().nullable(),
  queueSize: z.number().int(),
  categories: z.array(z.object({ key: z.string(), label: z.string() }).strict()),
  round: z.object({
    id: z.string(), version: z.number().int(), label: z.string(), formVersion: z.number().int(), closesAt: iso, inPool: z.boolean(),
    allowFreshEyesOverride: z.boolean(), allowConflictOverride: z.boolean(),
    form: z.array(z.record(z.string(), z.unknown())),
    board: z.array(z.object({ teamId: z.string(), teamName: z.string(), state: z.enum(["due", "seen", "busy", "done", "conflict"]) }).strict()),
    /** This mentor's own visit leases only. */
    leases: z.record(z.string(), z.object({ leaseId: z.string(), generation: z.number().int(), version: z.number().int(), expiresAt: iso }).strict()),
  }).strict().nullable(),
}).strict();

/** Teams assigned to this mentor and their conflicts: names only, never emails or answers. */
export const mentorTeamsDtoSchema = z.object({
  myTeams: z.array(z.object({ teamId: z.string(), teamName: z.string(), roundId: z.string().nullable() }).strict()),
  conflicts: z.array(z.object({ teamId: z.string(), teamName: z.string(), kind: z.string(), version: z.number().int(), mine: z.boolean() }).strict()),
}).strict();

export const mentorSlotsDtoSchema = z.object({
  slots: z.array(z.object({ id: z.string(), version: z.number().int(), startsAt: iso, endsAt: iso, start: localTime, end: localTime, location: z.string(), capacity: z.number().int(), teams: z.array(z.string()) }).strict()),
}).strict();

/* ---------- Organisers ---------- */

export const deskQueueDtoSchema = z.object({
  requests: z.array(z.object({
    id: z.string(), version: z.number().int(), status: helpStatus, origin: z.string(), category: z.string(), priority: z.number().int(),
    summary: z.string(), location: z.string(), who: z.string(), claimedBy: z.string().nullable(), claimedByUserId: z.string().nullable(),
    claimExpiresAt: iso.nullable(), deadline: iso, createdAt: iso, rating: z.number().int().nullable(), lapsed: z.boolean(),
  }).strict()),
  /** Mentors to assign to: names and load only (emails stay on the website). */
  mentors: z.array(z.object({ userId: z.string(), name: z.string(), onShift: z.boolean(), load: z.number().int() }).strict()),
}).strict();
