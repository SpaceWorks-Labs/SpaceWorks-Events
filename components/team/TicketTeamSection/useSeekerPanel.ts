"use client";

import { useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import {
  cancelTeamRequestAction,
  loadTicketInvitesPageAction,
  loadTicketRequestsPageAction,
  loadTicketSeekersPageAction,
  loadTicketTeamsPageAction,
  requestToJoinTeamAction,
  respondToTeamInviteAction,
  saveSeekerProfileAction,
} from "@/app/actions/teams";
import { EMPTY_CURSOR_PAGE, useCursorList } from "../useCursorList";
import { parseSkills, profileFieldErrors, seekerProfileErrors } from "./seekerProfile";
import type { LookingTeam, TicketSeekerPanelProps } from "./types";

/** The seeker panel's form state, paged lists and Server Action handlers. */
export function useSeekerPanel(props: TicketSeekerPanelProps) {
  const { ticketToken, profile, seekers, teams } = props;
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ tone: "success" | "danger"; message: string } | null>(null);
  const [editing, setEditing] = useState(!profile);
  const [headline, setHeadline] = useState(profile?.headline ?? "");
  const [skills, setSkills] = useState(profile?.skills.join(", ") ?? "");
  const [visible, setVisible] = useState(profile?.visible ?? true);
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [syncedProfile, setSyncedProfile] = useState(profile);
  const invites = useCursorList(props.invites, (_query, cursor) => loadTicketInvitesPageAction(ticketToken, { cursor }));
  const requests = useCursorList(props.requests, (_query, cursor) => loadTicketRequestsPageAction(ticketToken, { cursor }));
  const seekerList = useCursorList(seekers ?? EMPTY_CURSOR_PAGE, (query, cursor) => loadTicketSeekersPageAction(ticketToken, { query, cursor }));
  const teamList = useCursorList(teams ?? EMPTY_CURSOR_PAGE, (query, cursor) => loadTicketTeamsPageAction(ticketToken, { query, cursor }));

  /** Put the saved values back in the form fields. */
  function resetForm(saved: typeof profile) {
    setHeadline(saved?.headline ?? "");
    setSkills(saved?.skills.join(", ") ?? "");
    setVisible(saved?.visible ?? true);
    setErrors({});
  }

  // After a save, the refresh brings the stored profile (trimmed, duplicate
  // skills dropped). While the form is closed, show exactly that next time.
  if (syncedProfile !== profile) {
    setSyncedProfile(profile);
    if (!editing) resetForm(profile);
  }

  function startEditing() {
    resetForm(profile);
    setFeedback(null);
    setEditing(true);
  }

  function cancelEditing() {
    resetForm(profile);
    setEditing(false);
  }

  function run(id: string, task: () => Promise<void>) {
    setFeedback(null);
    setBusyId(id);
    startTransition(async () => {
      try {
        await task();
      } finally {
        setBusyId(null);
      }
    });
  }

  function save(e: FormEvent) {
    e.preventDefault();
    const parsedSkills = parseSkills(skills);
    const local = seekerProfileErrors(headline, parsedSkills);
    setErrors(local);
    if (Object.keys(local).length) return;
    run("profile", async () => {
      const res = await saveSeekerProfileAction(ticketToken, { headline, skills: parsedSkills, visible });
      if (!res.ok) {
        const shown = profileFieldErrors(res.fieldErrors);
        setErrors(shown);
        // Always say something: an error with no field to show it on goes in the banner.
        if (!Object.keys(shown).length) setFeedback({ tone: "danger", message: res.error });
        return;
      }
      setEditing(false);
      setFeedback({ tone: "success", message: visible ? "You're on the Looking for a team list." : "You're hidden from the list." });
      router.refresh();
    });
  }

  function setListed(next: boolean) {
    if (!profile) return;
    run("visibility", async () => {
      const res = await saveSeekerProfileAction(ticketToken, { headline: profile.headline, skills: profile.skills, visible: next });
      if (!res.ok) return setFeedback({ tone: "danger", message: res.error });
      setVisible(next);
      router.refresh();
    });
  }

  function answerInvite(requestId: string, accept: boolean) {
    run(requestId, async () => {
      const res = await respondToTeamInviteAction(ticketToken, requestId, accept);
      if (!res.ok) return setFeedback({ tone: "danger", message: res.error });
      setFeedback({ tone: "success", message: accept ? "You joined the team." : "Invitation declined." });
      router.refresh();
    });
  }

  function requestJoin(team: LookingTeam) {
    run(team.id, async () => {
      const res = await requestToJoinTeamAction(ticketToken, team.id);
      if (!res.ok) return setFeedback({ tone: "danger", message: res.error });
      setFeedback({ tone: "success", message: `Request sent to ${team.name}. Their leader can accept it from the team page.` });
      router.refresh();
    });
  }

  function withdraw(requestId: string) {
    run(requestId, async () => {
      const res = await cancelTeamRequestAction(ticketToken, requestId);
      if (!res.ok) return setFeedback({ tone: "danger", message: res.error });
      router.refresh();
    });
  }

  return {
    pending,
    busyId,
    feedback,
    editing,
    headline,
    setHeadline,
    skills,
    setSkills,
    visible,
    setVisible,
    errors,
    invites,
    requests,
    seekerList,
    teamList,
    startEditing,
    cancelEditing,
    save,
    setListed,
    answerInvite,
    requestJoin,
    withdraw,
  };
}

export type SeekerPanelState = ReturnType<typeof useSeekerPanel>;
