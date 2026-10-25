"use client";

import { useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import {
  addTeamMemberAction,
  cancelTeamInviteAction,
  disbandTeamAction,
  inviteSeekerAction,
  loadTeamJoinRequestsPageAction,
  loadTeamSeekersPageAction,
  regenerateTeamJoinLinkAction,
  regenerateTeamManageLinkAction,
  removeTeamMemberAction,
  renameTeamAction,
  respondToTeamRequestAction,
  setTeamLookingForMembersAction,
  transferTeamLeadershipAction,
} from "@/app/actions/teams";
import { EMPTY_CURSOR_PAGE, useCursorList } from "../useCursorList";
import { absolute, teamStatus } from "./helpers";
import type { Confirm, Feedback, TeamManagerProps, TeamManagerSeeker } from "./types";

/** The team page's state, paged lists and Server Action handlers. */
export function useTeamManager(props: TeamManagerProps) {
  const { teamRef, baseUrl, team, event, seekers } = props;
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [finished, setFinished] = useState<{ title: string; body: string; eventPath: string | null } | null>(null);
  const [copied, setCopied] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState(team.name);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [memberName, setMemberName] = useState("");
  const [memberEmail, setMemberEmail] = useState("");
  const [memberErrors, setMemberErrors] = useState<Record<string, string[]>>({});
  const [invited, setInvited] = useState<Set<string>>(() => new Set());
  const [busyId, setBusyId] = useState<string | null>(null);

  const status = teamStatus(team.status);
  const full = team.maxSize != null && team.size >= team.maxSize;
  const rejected = team.status === "REJECTED";
  const canAdd = event.registrationOpen && !full && !rejected && !event.inviteOnly;
  // Server-paged lists; each page re-checks the leader link on the server.
  const incoming = useCursorList(props.incomingRequests, (_query, cursor) => loadTeamJoinRequestsPageAction(teamRef, "REQUEST", { cursor }));
  const sent = useCursorList(props.sentInvites, (_query, cursor) => loadTeamJoinRequestsPageAction(teamRef, "INVITE", { cursor }));
  const seekerList = useCursorList(seekers ?? EMPTY_CURSOR_PAGE, (query, cursor) => loadTeamSeekersPageAction(teamRef, { query, cursor }));
  const hasIncoming = incoming.items.length > 0 || incoming.total > 0;
  const hasSent = sent.items.length > 0 || sent.total > 0;

  function run(id: string | null, task: () => Promise<void>) {
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

  async function copyJoinLink() {
    try {
      await navigator.clipboard.writeText(absolute(baseUrl, team.joinPath));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setFeedback({ tone: "danger", message: "Couldn't copy the link. Select it and copy it instead." });
    }
  }

  function closeConfirm() {
    if (pending) return;
    setConfirm(null);
    setConfirmError(null);
  }

  function confirmAction() {
    if (!confirm) return;
    setConfirmError(null);
    const current = confirm;
    run(null, async () => {
      if (current.kind === "remove") {
        const res = await removeTeamMemberAction(teamRef, current.member.rsvpId);
        if (!res.ok) return setConfirmError(res.error);
        setFeedback({ tone: "success", message: `${current.member.name} was removed from the team.` });
      } else if (current.kind === "transfer") {
        const res = await transferTeamLeadershipAction(teamRef, current.member.rsvpId);
        if (!res.ok) return setConfirmError(res.error);
        setConfirm(null);
        setFinished({
          title: "Leadership handed over",
          body: `${current.member.name} now leads ${team.name} and has been emailed the team link. This page no longer manages the team.`,
          eventPath: event.href,
        });
        return;
      } else if (current.kind === "rotateJoin") {
        const res = await regenerateTeamJoinLinkAction(teamRef);
        if (!res.ok) return setConfirmError(res.error);
        setFeedback({ tone: "success", message: "New join link created. The old link no longer works." });
      } else if (current.kind === "rotateManage") {
        const res = await regenerateTeamManageLinkAction(teamRef);
        if (!res.ok) return setConfirmError(res.error);
        setConfirm(null);
        // The old address is dead now: move to the new one and keep it out of history.
        if (res.data) router.replace(res.data.managePath);
        return;
      } else if (current.kind === "disband") {
        const res = await disbandTeamAction(teamRef);
        if (!res.ok) return setConfirmError(res.error);
        setConfirm(null);
        setFinished({
          title: "Team disbanded",
          body: "Every registration in the team was cancelled. Members can register again on their own or join another team.",
          eventPath: res.data?.eventPath ?? null,
        });
        return;
      }
      setConfirm(null);
      router.refresh();
    });
  }

  function submitRename(e: FormEvent) {
    e.preventDefault();
    setRenameError(null);
    run(null, async () => {
      const res = await renameTeamAction(teamRef, { name: renameValue });
      if (!res.ok) {
        setRenameError(res.fieldErrors?.name?.[0] ?? res.error);
        return;
      }
      setRenameOpen(false);
      setFeedback({ tone: "success", message: "Team renamed." });
      router.refresh();
    });
  }

  function submitMember(e: FormEvent) {
    e.preventDefault();
    setMemberErrors({});
    run("add-member", async () => {
      const res = await addTeamMemberAction(teamRef, { name: memberName, email: memberEmail });
      if (!res.ok) {
        setMemberErrors(res.fieldErrors ?? {});
        if (!res.fieldErrors) setFeedback({ tone: "danger", message: res.error });
        return;
      }
      setFeedback({ tone: "success", message: `${memberName.trim()} was added. They'll get their own ticket by email.` });
      setMemberName("");
      setMemberEmail("");
      router.refresh();
    });
  }

  function toggleLooking(looking: boolean) {
    run("looking", async () => {
      const res = await setTeamLookingForMembersAction(teamRef, looking);
      if (!res.ok) return setFeedback({ tone: "danger", message: res.error });
      router.refresh();
    });
  }

  function respond(requestId: string, accept: boolean) {
    run(requestId, async () => {
      const res = await respondToTeamRequestAction(teamRef, requestId, accept);
      if (!res.ok) return setFeedback({ tone: "danger", message: res.error });
      setFeedback({ tone: "success", message: accept ? "Request accepted. They're now in your team." : "Request declined." });
      router.refresh();
    });
  }

  function withdrawInvite(requestId: string) {
    run(requestId, async () => {
      const res = await cancelTeamInviteAction(teamRef, requestId);
      if (!res.ok) return setFeedback({ tone: "danger", message: res.error });
      router.refresh();
    });
  }

  function invite(seeker: TeamManagerSeeker) {
    run(seeker.id, async () => {
      const res = await inviteSeekerAction(teamRef, seeker.id);
      if (!res.ok) return setFeedback({ tone: "danger", message: res.error });
      setInvited((current) => new Set(current).add(seeker.id));
      setFeedback({ tone: "success", message: `Invitation sent to ${seeker.displayName}. They can accept it from their ticket page.` });
      router.refresh();
    });
  }

  return {
    pending,
    feedback,
    confirm,
    setConfirm,
    confirmError,
    finished,
    copied,
    renameOpen,
    setRenameOpen,
    renameValue,
    setRenameValue,
    renameError,
    setRenameError,
    memberName,
    setMemberName,
    memberEmail,
    setMemberEmail,
    memberErrors,
    invited,
    busyId,
    status,
    full,
    rejected,
    canAdd,
    incoming,
    sent,
    seekerList,
    hasIncoming,
    hasSent,
    copyJoinLink,
    closeConfirm,
    confirmAction,
    submitRename,
    submitMember,
    toggleLooking,
    respond,
    withdrawInvite,
    invite,
  };
}

export type TeamManagerState = ReturnType<typeof useTeamManager>;
