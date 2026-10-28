import type { JudgeSubmissionFilter } from "@/lib/judgingPaging";

/** `roundId`: a judging round other than the current one (docs/HACKATHON.md "Rounds"), read-only. */
export type Scope = { organisationSlug: string; eventId: string; roundId?: string | null };
export type ListView = { query: string; filter: JudgeSubmissionFilter };
