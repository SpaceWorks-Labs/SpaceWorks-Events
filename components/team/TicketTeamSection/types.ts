import type { CursorListPage } from "../useCursorList";

export type SeekerItem = { id: string; displayName: string; headline: string; skills: string[] };
export type LookingTeam = { id: string; name: string; size: number; maxSize: number | null; requested: boolean };
export type SeekerInvite = { id: string; teamName: string; size: number; maxSize: number | null };
export type SeekerRequest = { id: string; teamId: string; teamName: string };

export type TicketSeekerPanelProps = {
  ticketToken: string;
  profile: { headline: string; skills: string[]; visible: boolean } | null;
  /** First pages; "Show more" and searches fetch the rest through read-only actions. */
  invites: CursorListPage<SeekerInvite>;
  requests: CursorListPage<SeekerRequest>;
  /** Null while the holder isn't listed (the lists are only for visible seekers). */
  seekers: CursorListPage<SeekerItem> | null;
  teams: CursorListPage<LookingTeam> | null;
};
