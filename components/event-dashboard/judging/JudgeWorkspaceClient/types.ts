import type { JudgeSubmissionFilter } from "@/lib/judgingPaging";

export type Scope = { organisationSlug: string; eventId: string };
export type ListView = { query: string; filter: JudgeSubmissionFilter };
