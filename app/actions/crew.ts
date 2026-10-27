"use server";

import { z } from "zod";
import { auth } from "@/lib/auth";
import { recordAuditEvent } from "@/lib/audit";
import { isActionRateLimited } from "@/lib/actionRateLimit";
import { isUserEmailVerified } from "@/lib/permissions";
import { resolveOrganiserEvent } from "@/lib/core/teams";
import {
  addCrewMemberAsOrganiser,
  isCrewJoinTokenShape,
  joinCrewWithLink,
  loadCrewJoinPage,
  moveCrewMember,
  removeCrewMember,
  setCrewJoinLink,
  setCrewMemberVisibility,
  updateCrewMemberAsOrganiser,
} from "@/lib/core/crew";
import type { ActionResult } from "./org";
import { NO_PERMISSION, auditCrew, gate, memberTargetSchema, revalidateCrew, storeCrewPhoto, targetSchema } from "./crew/helpers";

/*
 * Event crew (Guests → Crew, docs/CREW.md). Organiser actions need
 * MANAGE_REGISTRATIONS and are audited with ids only. The crew link actions
 * are public: the link token is the capability, and both are rate limited
 * per IP (and per email or token).
 */

/** Add a crew member and email them their ticket. `member` is the crew form. */
export async function addCrewMember(input: unknown): Promise<ActionResult<{ id: string }>> {
  const g = await gate(input, targetSchema.extend({ member: z.unknown() }));
  if (!g.ok) return g;
  const result = await addCrewMemberAsOrganiser(g.crew, g.data.member);
  if (!result.ok) return result;
  await auditCrew(g.event, "EVENT_CREW_MEMBER_ADDED", "EventCrewMember", result.data.id);
  revalidateCrew(g.event.orgSlug, { id: g.event.eventId, slug: g.event.eventSlug });
  return result;
}

export async function updateCrewMember(input: unknown): Promise<ActionResult> {
  const g = await gate(input, memberTargetSchema.extend({ member: z.unknown() }));
  if (!g.ok) return g;
  const result = await updateCrewMemberAsOrganiser(g.crew, g.data.memberId, g.data.member);
  if (!result.ok) return result;
  await auditCrew(g.event, "EVENT_CREW_MEMBER_UPDATED", "EventCrewMember", g.data.memberId);
  revalidateCrew(g.event.orgSlug, { id: g.event.eventId, slug: g.event.eventSlug });
  return { ok: true };
}

export async function setCrewMemberShown(input: unknown): Promise<ActionResult> {
  const g = await gate(input, memberTargetSchema.extend({ showOnPage: z.boolean() }));
  if (!g.ok) return g;
  const result = await setCrewMemberVisibility(g.crew, g.data.memberId, g.data.showOnPage);
  if (!result.ok) return result;
  await auditCrew(g.event, "EVENT_CREW_MEMBER_UPDATED", "EventCrewMember", g.data.memberId);
  revalidateCrew(g.event.orgSlug, { id: g.event.eventId, slug: g.event.eventSlug });
  return { ok: true };
}

/** Removes the member and deletes their free crew ticket. */
export async function deleteCrewMember(input: unknown): Promise<ActionResult> {
  const g = await gate(input, memberTargetSchema);
  if (!g.ok) return g;
  const result = await removeCrewMember(g.crew, g.data.memberId);
  if (!result.ok) return result;
  await auditCrew(g.event, "EVENT_CREW_MEMBER_REMOVED", "EventCrewMember", g.data.memberId);
  revalidateCrew(g.event.orgSlug, { id: g.event.eventId, slug: g.event.eventSlug });
  return { ok: true };
}

export async function reorderCrewMember(input: unknown): Promise<ActionResult> {
  const g = await gate(input, memberTargetSchema.extend({ direction: z.union([z.literal(-1), z.literal(1)]) }));
  if (!g.ok) return g;
  const result = await moveCrewMember(g.crew, g.data.memberId, g.data.direction);
  if (!result.ok) return result;
  revalidateCrew(g.event.orgSlug, { id: g.event.eventId, slug: g.event.eventSlug });
  return { ok: true };
}

/** Create, replace or turn off the crew sign-up link. Returns the token (null once off). */
export async function manageCrewJoinLink(input: unknown): Promise<ActionResult<{ token: string } | null>> {
  const g = await gate(input, targetSchema.extend({ action: z.enum(["create", "rotate", "disable"]) }));
  if (!g.ok) return g;
  const result = await setCrewJoinLink(g.crew, g.data.action);
  if (!result.ok) return result;
  const action = g.data.action === "disable" ? "EVENT_CREW_LINK_DISABLED" : g.data.action === "rotate" ? "EVENT_CREW_LINK_ROTATED" : "EVENT_CREW_LINK_CREATED";
  await auditCrew(g.event, action, "Event", g.event.eventId);
  return result;
}

/** Organiser photo upload: FormData with organisationSlug, eventId and file. */
export async function uploadCrewPhoto(formData: FormData): Promise<ActionResult<{ url: string }>> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return { ok: false, error: "You must be signed in." };
  if (!(await isUserEmailVerified(userId))) return { ok: false, error: "Verify your email before uploading crew photos." };
  // Crew photos are event page images, so they share the event page upload budget.
  if (await isActionRateLimited("eventPageUpload", userId)) return { ok: false, error: "Too many uploads. Please try again later." };
  const parsed = targetSchema.safeParse({ organisationSlug: formData.get("organisationSlug"), eventId: formData.get("eventId") });
  const file = formData.get("file");
  if (!parsed.success || !(file instanceof File)) return { ok: false, error: "Choose a photo to upload." };
  const event = await resolveOrganiserEvent(userId, parsed.data.organisationSlug, parsed.data.eventId);
  if (!event) return { ok: false, error: NO_PERMISSION };
  const stored = await storeCrewPhoto(file, event.organisationId);
  if (stored.ok) await recordAuditEvent({ action: "EVENT_CREW_PHOTO_UPLOADED", actorUserId: userId, organisationId: event.organisationId, targetType: "Event", targetId: event.eventId });
  return stored;
}

/** Crew-link photo upload: FormData with token and file. Rate limited per IP and token. */
export async function uploadCrewPhotoWithLink(formData: FormData): Promise<ActionResult<{ url: string }>> {
  const token = formData.get("token");
  const file = formData.get("file");
  if (!isCrewJoinTokenShape(token) || !(file instanceof File)) return { ok: false, error: "Choose a photo to upload." };
  // Per IP and per link (the subject is hashed before it reaches Redis), in the crew photo budget.
  if (await isActionRateLimited("crewPhotoUpload", token)) return { ok: false, error: "Too many uploads. Please try again later." };
  const page = await loadCrewJoinPage(token);
  if (!page?.open) return { ok: false, error: "This crew link is no longer valid. Ask the organisers for a new one." };
  return storeCrewPhoto(file, page.organisationId);
}

/** Self sign-up from /crew/[token]. `member` is the crew profile form. */
export async function joinCrew(input: unknown): Promise<ActionResult<{ eventTitle: string }>> {
  const parsed = z.object({ token: z.string().max(256), member: z.unknown() }).strict().safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input." };
  const member = parsed.data.member;
  const email = typeof member === "object" && member && "email" in member && typeof member.email === "string" ? member.email : undefined;
  if (await isActionRateLimited("rsvp", email)) return { ok: false, error: "Too many sign-up attempts. Please try again shortly." };
  const result = await joinCrewWithLink(parsed.data.token, member);
  if (!result.ok) return result;
  const page = await loadCrewJoinPage(parsed.data.token);
  if (page) {
    await recordAuditEvent({ action: "EVENT_CREW_JOINED_WITH_LINK", organisationId: page.organisationId, targetType: "Event", targetId: page.eventId });
    revalidateCrew(page.organisationSlug, { id: page.eventId, slug: page.eventSlug });
  }
  return result;
}
