"use server";

import { revalidatePath as nextRevalidatePath } from "next/cache";
import { trackedRevalidation } from "@/lib/frontend/revalidation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import {
  createOrganisationSchema,
  updateOrganisationSchema,
} from "@/lib/validators";
import { flattenZodErrors } from "./utils";
import { recordAuditEvent } from "@/lib/audit";
import { isActionRateLimited } from "@/lib/actionRateLimit";
import { isOrganisationUploadUrl } from "@/lib/uploadUrl";
import type { ActionErrorCode } from "@/lib/actionErrorCode";

const revalidatePath = trackedRevalidation(nextRevalidatePath);

export type ActionResult<T = void> =
  | { ok: true; data?: T; }
  | {
    ok: false;
    error: string;
    fieldErrors?: Record<string, string[]>;
    /** e.g. check-in requires staff override for this RSVP status */
    needsForce?: boolean;
    /** The action needs a fresh sign-in (lib/reauth.ts); the UI offers one. */
    reauthRequired?: boolean;
    /** Machine-readable reason for API clients; e.g. a TEAMS_ONLY event refusing a solo registration. */
    code?: ActionErrorCode;
  };

export async function createOrganisation(
  input: unknown,
): Promise<ActionResult<{ slug: string; }>> {
  const session = await auth();
  if (!session?.user?.id) {
    return { ok: false, error: "You must be signed in." };
  }
  if (await isActionRateLimited("create", session.user.id)) {
    return {
      ok: false,
      error: "Too many creation attempts. Please try again later.",
    };
  }

  const parsed = createOrganisationSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Invalid input.",
      fieldErrors: flattenZodErrors(parsed.error),
    };
  }

  const { name, slug, description, logoUrl } = parsed.data;

  try {
    const org = await prisma.$transaction(async (tx) => {
      const created = await tx.organisation.create({
        data: {
          name,
          slug,
          description: description ?? "",
          logoUrl: logoUrl || null,
        },
      });
      await tx.membership.create({
        data: {
          userId: session.user.id,
          organisationId: created.id,
          role: "OWNER",
        },
      });
      return created;
    });

    await recordAuditEvent({
      action: "ORGANISATION_CREATED",
      actorUserId: session.user.id,
      organisationId: org.id,
      targetType: "Organisation",
      targetId: org.id,
    });

    revalidatePath("/dashboard");
    revalidatePath(`/${org.slug}`);
    return { ok: true, data: { slug: org.slug } };
  } catch (e: unknown) {
    if (
      typeof e === "object" &&
      e !== null &&
      "code" in e &&
      (e as { code: string; }).code === "P2002"
    ) {
      return {
        ok: false,
        error: "That organisation URL is already taken.",
        fieldErrors: { slug: ["Already taken"] },
      };
    }
    console.error("[organisation] creation failed");
    return { ok: false, error: "Could not create organisation." };
  }
}

export async function updateOrganisation(
  input: unknown,
): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return { ok: false, error: "You must be signed in." };
  }

  const parsed = updateOrganisationSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Invalid input.",
      fieldErrors: flattenZodErrors(parsed.error),
    };
  }

  const { organisationSlug, name, description, logoUrl } = parsed.data;
  const org = await prisma.organisation.findUnique({
    where: { slug: organisationSlug },
    select: { id: true, slug: true },
  });
  if (!org) return { ok: false, error: "Organisation not found." };

  const membership = await prisma.membership.findUnique({
    where: {
      userId_organisationId: {
        userId: session.user.id,
        organisationId: org.id,
      },
    },
    select: { role: true },
  });

  if (
    !membership ||
    (membership.role !== "OWNER" && membership.role !== "ADMIN")
  ) {
    return { ok: false, error: "Only organisation admins can edit settings." };
  }
  if (
    logoUrl &&
    !isOrganisationUploadUrl(logoUrl, org.id, "organisation-logos")
  ) {
    return { ok: false, error: "Choose an uploaded organisation logo." };
  }

  try {
    await prisma.organisation.update({
      where: { id: org.id },
      data: {
        name,
        description: description ?? "",
        logoUrl: logoUrl || null,
      },
    });
    await recordAuditEvent({
      action: "ORGANISATION_UPDATED",
      actorUserId: session.user.id,
      organisationId: org.id,
      targetType: "Organisation",
      targetId: org.id,
    });
    revalidatePath(`/dashboard/${org.slug}`);
    revalidatePath(`/dashboard/${org.slug}/members`);
    revalidatePath(`/${org.slug}`);
    return { ok: true };
  } catch {
    console.error("[organisation] update failed");
    return { ok: false, error: "Could not update organisation." };
  }
}

/** Format, reserved-word and uniqueness check for the create form; `error` explains an unusable slug. */
export async function checkSlugAvailability(
  slug: string,
): Promise<{ available: boolean; error?: string; }> {
  const parsed = createOrganisationSchema.shape.slug.safeParse(String(slug ?? "").toLowerCase());
  if (!parsed.success) {
    return { available: false, error: parsed.error.issues[0]?.message ?? "That URL can't be used" };
  }

  const count = await prisma.organisation.count({
    where: { slug: parsed.data },
  });

  return count === 0
    ? { available: true }
    : { available: false, error: "That URL is already taken" };
}
