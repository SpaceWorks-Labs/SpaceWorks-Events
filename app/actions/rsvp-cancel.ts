"use server";

import { auth } from "@/lib/auth";
import { z } from "zod";
import { isActionRateLimited } from "@/lib/actionRateLimit";
import { cancelRegistrationByToken } from "@/lib/rsvpCancel";
import type { ActionResult } from "./org";

const cancelRsvpSchema = z.object({ checkInToken: z.string().trim().min(8).max(256) }).strict();

/**
 * Cancel an RSVP. The caller must either be the logged-in user who owns the
 * RSVP, or supply the correct `checkInToken` (guest cancellation). The rules
 * live in lib/rsvpCancel.ts.
 */
export async function cancelRsvp(input: unknown): Promise<ActionResult<{ cancelled: true; }>> {
  const parsed = cancelRsvpSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Missing token." };
  }
  const { checkInToken } = parsed.data;
  if (await isActionRateLimited("rsvp", checkInToken)) return { ok: false, error: "Too many cancellation attempts. Please try again shortly." };
  const session = await auth();
  return cancelRegistrationByToken(session?.user?.id ?? null, checkInToken);
}
