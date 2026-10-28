import type { SubmissionViewFilter } from "@/lib/judgingOrganiserPaging";

export type Filter = SubmissionViewFilter;
export type View = { query: string; status: Filter };

export const FILTERS: Array<{ value: Filter; label: string }> = [
  { value: "all", label: "All" },
  { value: "SUBMITTED", label: "Submitted" },
  { value: "DRAFT", label: "Drafts" },
  { value: "WITHDRAWN", label: "Withdrawn" },
  { value: "DISQUALIFIED", label: "Disqualified" },
  { value: "notSubmitted", label: "Not submitted" },
];

export const SEARCH_DELAY_MS = 300;
