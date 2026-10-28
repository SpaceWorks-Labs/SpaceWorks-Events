import { revalidatePath as nextRevalidatePath } from "next/cache";
import type { z } from "zod";
import { auth } from "@/lib/auth";
import { isActionRateLimited } from "@/lib/actionRateLimit";
import { trackedRevalidation } from "@/lib/frontend/revalidation";
import { resolveAdmissionOrganiser, resolveAdmissionReviewer, type AdmissionContext } from "@/lib/admission/access";
import type { ActionResult } from "../org";

/*
 * Shared checks for the application actions (docs/ADMISSION.md): signed in,
 * rate limited (the "rsvp" bucket, like the guest list), the input parsed,
 * and the organisation and event resolved on the server with the right
 * access. Kept out of the "use server" files, which export actions only.
 */

const revalidatePath = trackedRevalidation(nextRevalidatePath);

export type Gated<T> = { ok: true; ctx: AdmissionContext; data: T } | { ok: false; error: string };

type Scoped = z.ZodType<{ organisationSlug: string; eventId: string }>;

async function gate<S extends Scoped>(schema: S, input: unknown, resolve: typeof resolveAdmissionOrganiser, denied: string): Promise<Gated<z.infer<S>>> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return { ok: false, error: "You must be signed in." };
  if (await isActionRateLimited("rsvp", userId)) return { ok: false, error: "Too many updates. Try again shortly." };
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Check the form and try again." };
  const ctx = await resolve(userId, parsed.data.organisationSlug, parsed.data.eventId);
  if (!ctx) return { ok: false, error: denied };
  return { ok: true, ctx, data: parsed.data };
}

export function organiserGate<S extends Scoped>(schema: S, input: unknown) {
  return gate(schema, input, resolveAdmissionOrganiser, "You do not have permission to manage this event's applications.");
}

export function reviewerGate<S extends Scoped>(schema: S, input: unknown) {
  return gate(schema, input, resolveAdmissionReviewer, "You do not have permission to review this event's applications.");
}

export function revalidateAdmission(ctx: AdmissionContext) {
  revalidatePath(`/dashboard/${ctx.orgSlug}/event/${ctx.eventId}`);
  revalidatePath(`/${ctx.orgSlug}/${ctx.eventSlug}`);
}

/** Map a core result onto an action result, revalidating on success. */
export function done<T>(ctx: AdmissionContext, result: { ok: true; data?: T } | { ok: false; error: string }): ActionResult<T> {
  if (!result.ok) return { ok: false, error: result.error };
  revalidateAdmission(ctx);
  return { ok: true, data: result.data };
}
