"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { ActionResult } from "@/app/actions/org";
import { isActionRateLimited } from "@/lib/actionRateLimit";
import { auth } from "@/lib/auth";
import { createSafeWebpDerivative } from "@/lib/imageValidation";
import { getPublicUrl, uploadFile } from "@/lib/storage";
import { editableDesign, resolveDesignActor, type DesignActor } from "@/lib/ticketDesign/access";
import { assignDesign, createDesign, deleteDesign, saveDesign } from "@/lib/ticketDesign/store";

/**
 * The ticket designer (docs/TICKET_DESIGNER.md). Library templates and the
 * organisation default: owners and admins. An event's designs: EDIT_DETAILS
 * on that event. lib/ticketDesign/store.ts re-checks both on every call.
 */

const slug = z.string().trim().min(1).max(120);
const id = z.string().trim().min(1).max(128);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

async function actor(organisationSlug: unknown, bucket: "action" | "designAutosave" | "upload" = "action"): Promise<DesignActor | { error: string; }> {
  const parsed = slug.safeParse(organisationSlug);
  if (!parsed.success) return { error: "Organisation not found." };
  const session = await auth();
  if (!session?.user?.id) return { error: "You must be signed in." };
  const resolved = await resolveDesignActor(session.user.id, parsed.data);
  if (!resolved) return { error: "Organisation not found." };
  if (await isActionRateLimited(bucket, session.user.id)) return { error: "Too many changes. Try again shortly." };
  return resolved;
}

function refresh(actorValue: DesignActor, eventId?: string | null) {
  revalidatePath(`/dashboard/${actorValue.organisationSlug}/ticket-designs`);
  if (eventId) revalidatePath(`/dashboard/${actorValue.organisationSlug}/event/${eventId}`);
}

const createSchema = z.object({ organisationSlug: slug, eventId: id.nullable().optional(), name: z.string().max(80).optional(), starter: z.string().max(40).nullable().optional(), fromDesignId: id.nullable().optional() }).strict();

export async function createTicketDesignAction(input: unknown): Promise<ActionResult<{ id: string; }>> {
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Check the design details." };
  const who = await actor(parsed.data.organisationSlug);
  if ("error" in who) return { ok: false, error: who.error };
  const result = await createDesign(who, parsed.data);
  if (result.ok) refresh(who, parsed.data.eventId);
  return result;
}

const saveSchema = z.object({ organisationSlug: slug, designId: id, document: z.unknown(), name: z.string().max(80).optional() }).strict();

/** Autosave from the editor. */
export async function saveTicketDesignAction(input: unknown): Promise<ActionResult<{ updatedAt: string; }>> {
  const parsed = saveSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "This design can't be saved." };
  const who = await actor(parsed.data.organisationSlug, "designAutosave");
  if ("error" in who) return { ok: false, error: who.error };
  return saveDesign(who, parsed.data.designId, { document: parsed.data.document, name: parsed.data.name });
}

export async function deleteTicketDesignAction(input: unknown): Promise<ActionResult> {
  const parsed = z.object({ organisationSlug: slug, designId: id }).strict().safeParse(input);
  if (!parsed.success) return { ok: false, error: "Design not found." };
  const who = await actor(parsed.data.organisationSlug);
  if ("error" in who) return { ok: false, error: who.error };
  const design = await editableDesign(who, parsed.data.designId);
  const result = await deleteDesign(who, parsed.data.designId);
  if (result.ok) refresh(who, design?.eventId);
  return result;
}

const assignSchema = z.object({
  organisationSlug: slug,
  target: z.enum(["event", "ticketType", "default"]),
  eventId: id.nullable().optional(),
  ticketTypeId: id.nullable().optional(),
  designId: id.nullable(),
}).strict();

/** Choose the design an event, a ticket type or the organisation default uses (null falls back). */
export async function assignTicketDesignAction(input: unknown): Promise<ActionResult> {
  const parsed = assignSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Choose a design." };
  const who = await actor(parsed.data.organisationSlug);
  if ("error" in who) return { ok: false, error: who.error };
  const result = await assignDesign(who, parsed.data);
  if (result.ok) refresh(who, parsed.data.eventId);
  return result;
}

/** An image for a design (multipart: organisationSlug, designId, file), re-encoded as WebP like other uploads. */
export async function uploadTicketDesignImageAction(formData: FormData): Promise<ActionResult<{ url: string; }>> {
  const who = await actor(formData.get("organisationSlug"), "upload");
  if ("error" in who) return { ok: false, error: who.error };
  const design = await editableDesign(who, String(formData.get("designId") ?? ""));
  if (!design) return { ok: false, error: "Design not found." };
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: "Choose an image to upload." };
  if (file.size > MAX_IMAGE_BYTES) return { ok: false, error: "Images must be 5 MB or smaller." };
  const derivative = await createSafeWebpDerivative(file, { width: 1600, height: 1600, fit: "inside" });
  if ("error" in derivative) return { ok: false, error: derivative.error };
  const key = `organisations/${who.organisationId}/ticket-design-images/${randomUUID()}.webp`;
  await uploadFile({ key, body: derivative.body, contentType: "image/webp", organisationId: who.organisationId });
  return { ok: true, data: { url: new URL(getPublicUrl(key), "http://local.invalid").pathname } };
}
