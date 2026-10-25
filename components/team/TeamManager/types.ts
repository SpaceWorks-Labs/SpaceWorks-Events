import type { ReactNode } from "react";
import type { TeamRef } from "@/app/actions/teams";
import type { CursorListPage } from "../useCursorList";

export type TeamManagerMember = { rsvpId: string; name: string; isLeader: boolean; checkedIn: boolean };
export type TeamManagerRequest = { id: string; direction: "INVITE" | "REQUEST"; displayName: string; headline: string | null; skills: string[] };
export type TeamManagerSeeker = { id: string; displayName: string; headline: string; skills: string[] };

export type TeamManagerProps = {
  teamRef: TeamRef;
  /** True on `/team/{token}`: the management link itself can be rotated there. */
  tokenPage: boolean;
  /** Absolute origin for shareable links; empty means "use this browser's origin". */
  baseUrl: string;
  team: {
    name: string;
    status: "CONFIRMED" | "WAITLISTED" | "PENDING_APPROVAL" | "PENDING_PAYMENT" | "REJECTED";
    size: number;
    minSize: number | null;
    maxSize: number | null;
    incomplete: boolean;
    lookingForMembers: boolean;
    joinPath: string;
  };
  event: { title: string; href: string; whenLabel: string; registrationOpen: boolean; matching: boolean; inviteOnly: boolean };
  members: TeamManagerMember[];
  /** First pages of pending requests received and invitations sent; "Show more" fetches the rest. */
  incomingRequests: CursorListPage<TeamManagerRequest>;
  sentInvites: CursorListPage<TeamManagerRequest>;
  /** First page of the Looking for a team list; null when it is not available (no matching, team full or rejected). */
  seekers: CursorListPage<TeamManagerSeeker> | null;
  /** The team's hackathon submission section (docs/HACKATHON.md), rendered server-side; null when the event takes none. */
  submissionSlot?: ReactNode;
};

export type Feedback = { tone: "success" | "danger"; message: string } | null;
export type Confirm =
  | { kind: "remove"; member: TeamManagerMember }
  | { kind: "transfer"; member: TeamManagerMember }
  | { kind: "rotateJoin" }
  | { kind: "rotateManage" }
  | { kind: "disband" }
  | null;
