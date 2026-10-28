import "server-only";

import type { MentorContext } from "@/lib/core/mentorDesk/access";
import { loadParticipantDesk } from "@/lib/core/mentorDesk/readsParticipant";
import { loadMentorConsole } from "@/lib/core/mentorDesk/readsMentor";
import { loadDeskOrganiserView } from "@/lib/core/mentorDesk/readsOrganiser";
import type { DeskOrganiserContext, ParticipantContext } from "@/lib/core/mentorDesk/access";
import { deskQueueDtoSchema, mentorConsoleDtoSchema, mentorQueueDtoSchema, mentorSlotsDtoSchema, mentorTeamsDtoSchema, participantDeskDtoSchema } from "@/lib/mobile/schemas";

/* Mentor Desk reads for the app: the web's read models, narrowed to strict DTOs. */

export const MENTOR_QUEUE_PAGE = 25;

export async function participantDesk(p: ParticipantContext) {
  const view = await loadParticipantDesk(p);
  return view ? participantDeskDtoSchema.parse(view) : null;
}

export async function mentorConsole(m: MentorContext) {
  const view = await loadMentorConsole(m);
  if (!view) return null;
  return mentorConsoleDtoSchema.parse({
    timezone: view.timezone,
    onShift: view.onShift,
    profile: view.profile,
    claim: view.claim,
    queueSize: view.queue.length,
    categories: view.categories,
    round: view.round,
  });
}

/** The open requests this mentor may see, in the web's order, a page at a time (`cursor` is an opaque offset). */
export async function mentorQueue(m: MentorContext, cursor: string | undefined) {
  const view = await loadMentorConsole(m);
  if (!view) return null;
  const offset = cursor ? Number.parseInt(Buffer.from(cursor, "base64url").toString("utf8"), 10) : 0;
  if (!Number.isSafeInteger(offset) || offset < 0) return undefined;
  const page = view.queue.slice(offset, offset + MENTOR_QUEUE_PAGE);
  const next = offset + MENTOR_QUEUE_PAGE < view.queue.length ? Buffer.from(String(offset + MENTOR_QUEUE_PAGE)).toString("base64url") : null;
  return mentorQueueDtoSchema.parse({ requests: page, nextCursor: next });
}

export async function mentorTeams(m: MentorContext) {
  const view = await loadMentorConsole(m);
  if (!view) return null;
  return mentorTeamsDtoSchema.parse({
    myTeams: view.myTeams,
    // The reason stays with organisers.
    conflicts: view.conflicts.map((conflict) => ({ teamId: conflict.teamId, teamName: conflict.teamName, kind: conflict.kind, version: conflict.version, mine: conflict.mine })),
  });
}

export async function mentorSlots(m: MentorContext) {
  const view = await loadMentorConsole(m);
  return view ? mentorSlotsDtoSchema.parse({ slots: view.slots }) : null;
}

export async function deskQueue(o: DeskOrganiserContext) {
  const view = await loadDeskOrganiserView(o);
  if (!view) return null;
  return deskQueueDtoSchema.parse({
    requests: view.requests,
    mentors: view.mentors.map((mentor) => ({ userId: mentor.userId, name: mentor.name, onShift: mentor.onShift, load: mentor.load })),
  });
}
