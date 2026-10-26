"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { ActionResult } from "@/app/actions/org";
import { isActionRateLimited } from "@/lib/actionRateLimit";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getMembership, isOrgAdmin } from "@/lib/permissions";
import { recordPrizePayout, reversePrizePayout, setAwardPrize, type PrizeContext } from "@/lib/prizes";

const scopeSchema = z.object({ organisationSlug: z.string().trim().min(1).max(120), eventId: z.string().trim().min(1).max(128) }).strict();

/** Prize money is an organisation OWNER/ADMIN matter (docs/HACKATHON.md); collaborators never qualify. */
async function requirePrizeAdmin(scope: unknown): Promise<{ error: string; } | { ctx: PrizeContext; path: string; }> {
  const parsed = scopeSchema.safeParse(scope);
  if (!parsed.success) return { error: "Event not found." };
  const session = await auth();
  if (!session?.user?.id) return { error: "You must be signed in." };
  const organisation = await prisma.organisation.findUnique({ where: { slug: parsed.data.organisationSlug }, select: { id: true, slug: true } });
  if (!organisation) return { error: "Event not found." };
  const membership = await getMembership(session.user.id, organisation.id);
  if (!membership || !isOrgAdmin(membership.role)) return { error: "Only organisation owners and admins can manage prize money." };
  const event = await prisma.event.findFirst({ where: { id: parsed.data.eventId, organisationId: organisation.id }, select: { id: true } });
  if (!event) return { error: "Event not found." };
  if (await isActionRateLimited("action", session.user.id)) return { error: "Too many changes. Try again shortly." };
  return { ctx: { organisationId: organisation.id, eventId: event.id, userId: session.user.id }, path: `/dashboard/${organisation.slug}/event/${event.id}` };
}

async function run(scope: unknown, task: (ctx: PrizeContext) => Promise<{ ok: true; } | { ok: false; error: string; }>): Promise<ActionResult> {
  const access = await requirePrizeAdmin(scope);
  if ("error" in access) return { ok: false, error: access.error };
  const result = await task(access.ctx);
  if (result.ok) revalidatePath(access.path);
  return result;
}

/** Set or clear an award's prize per winner. */
export async function setAwardPrizeAction(scope: unknown, input: unknown): Promise<ActionResult> {
  return run(scope, (ctx) => setAwardPrize(ctx, input));
}

/** Record prize money paid to a winner by hand. */
export async function recordPrizePayoutAction(scope: unknown, input: unknown): Promise<ActionResult> {
  return run(scope, (ctx) => recordPrizePayout(ctx, input));
}

/** Reverse a payout recorded by mistake (a new ledger row; nothing is edited). */
export async function reversePrizePayoutAction(scope: unknown, input: unknown): Promise<ActionResult> {
  return run(scope, (ctx) => reversePrizePayout(ctx, input));
}
