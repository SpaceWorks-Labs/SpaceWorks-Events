"use server";

import { revalidatePath as nextRevalidatePath } from "next/cache";
import { trackedRevalidation } from "@/lib/frontend/revalidation";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { isActionRateLimited } from "@/lib/actionRateLimit";
import { recordAuditEvent } from "@/lib/audit";
import type { ActionResult } from "./org";
import { flattenZodErrors } from "./utils";

const revalidatePath = trackedRevalidation(nextRevalidatePath);

const leaveOrganisationSchema = z.object({
  organisationSlug: z.string().trim().min(1).max(100),
});

const NOT_A_MEMBER = "You are not a member of this organisation.";
// Ownership cannot be handed over (roles stop at admin), so the only owner can delete the organisation instead.
const SOLE_OWNER_ERROR = "You are the only owner, so you can't leave. Delete the organisation from its settings instead.";

/**
 * The signed-in person leaves an organisation. Only their own membership is
 * removed; event co-organiser grants are separate per-event permissions and
 * are deliberately left untouched (an organisation admin can revoke them).
 *
 * The last-owner check and the delete run in one transaction holding a row
 * lock on the organisation, so two co-owners leaving at the same time cannot
 * both pass the check and leave the organisation ownerless.
 */
export async function leaveOrganisation(input: unknown): Promise<ActionResult> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return { ok: false, error: "You must be signed in." };

  const parsed = leaveOrganisationSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Invalid input.", fieldErrors: flattenZodErrors(parsed.error) };
  }

  if (await isActionRateLimited("action", userId)) {
    return { ok: false, error: "Too many attempts. Please try again later." };
  }

  const org = await prisma.organisation.findUnique({
    where: { slug: parsed.data.organisationSlug },
    select: { id: true, slug: true },
  });
  // Same answer for an unknown slug and a non-member: nothing to leave either way.
  if (!org) return { ok: false, error: NOT_A_MEMBER };

  const outcome = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Organisation" WHERE "id" = ${org.id} FOR UPDATE`;
    const membership = await tx.membership.findUnique({
      where: { userId_organisationId: { userId, organisationId: org.id } },
      select: { id: true, role: true },
    });
    if (!membership) return "not-member" as const;
    if (membership.role === "OWNER") {
      const owners = await tx.membership.count({ where: { organisationId: org.id, role: "OWNER" } });
      if (owners <= 1) return "sole-owner" as const;
    }
    // Scoped to the caller's own user id as well as the row id.
    const removed = await tx.membership.deleteMany({ where: { id: membership.id, userId, organisationId: org.id } });
    if (removed.count !== 1) return "not-member" as const;
    await recordAuditEvent({
      action: "ORGANISATION_MEMBER_LEFT",
      actorUserId: userId,
      organisationId: org.id,
      targetType: "membership",
      targetId: membership.id,
      metadata: { role: membership.role },
      client: tx,
    });
    return "left" as const;
  });

  if (outcome === "not-member") return { ok: false, error: NOT_A_MEMBER };
  if (outcome === "sole-owner") return { ok: false, error: SOLE_OWNER_ERROR };

  revalidatePath("/account/organisations");
  revalidatePath("/dashboard");
  revalidatePath(`/dashboard/${org.slug}`);
  revalidatePath(`/dashboard/${org.slug}/members`);
  return { ok: true };
}
