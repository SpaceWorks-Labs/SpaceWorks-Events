import "server-only";

import { EventPermission, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { canManageRegistrationsFor } from "@/lib/eventAccess";
import { getMembership, isOrgAdmin } from "@/lib/permissions";
import { staffMfaSatisfied } from "@/lib/staffMfa";

/*
 * Who may do what with applications (docs/ADMISSION.md, docs/PERMISSIONS.md).
 * The organisation comes from its slug and the event is re-read inside it;
 * results carry ids only. Callers authenticate first. Staff MFA applies to
 * every staff path: getMembership and canAccessEvent return no access until
 * the authenticator check is passed.
 *
 * - Organisers (stages, panels, assignment, decisions, offers): organisation
 *   OWNER/ADMIN or the event's MANAGE_REGISTRATIONS grant, the same check as
 *   the guest list's approve and decline.
 * - Turning applications on or off and the admission settings: OWNER/ADMIN.
 * - Reviewers: OWNER/ADMIN or the REVIEW_APPLICATIONS grant, and only the
 *   applications assigned to them.
 */

export type AdmissionContext = {
  userId: string;
  organisationId: string;
  orgSlug: string;
  eventId: string;
  eventSlug: string;
  isAdmin: boolean;
};

async function loadEventInOrg(organisationSlug: string, eventId: string) {
  if (!organisationSlug || organisationSlug.length > 128 || !eventId || eventId.length > 128) return null;
  const org = await prisma.organisation.findUnique({ where: { slug: organisationSlug }, select: { id: true, slug: true } });
  if (!org) return null;
  const event = await prisma.event.findFirst({ where: { id: eventId, organisationId: org.id }, select: { id: true, slug: true } });
  return event ? { org, event } : null;
}

export async function resolveAdmissionOrganiser(userId: string, organisationSlug: string, eventId: string): Promise<AdmissionContext | null> {
  if (!userId) return null;
  const found = await loadEventInOrg(organisationSlug, eventId);
  if (!found) return null;
  if (!(await canManageRegistrationsFor({ userId, organisationId: found.org.id, eventId: found.event.id }))) return null;
  const membership = await getMembership(userId, found.org.id);
  return { userId, organisationId: found.org.id, orgSlug: found.org.slug, eventId: found.event.id, eventSlug: found.event.slug, isAdmin: Boolean(membership && isOrgAdmin(membership.role)) };
}

export async function resolveAdmissionReviewer(userId: string, organisationSlug: string, eventId: string): Promise<AdmissionContext | null> {
  if (!userId) return null;
  const found = await loadEventInOrg(organisationSlug, eventId);
  if (!found) return null;
  const membership = await getMembership(userId, found.org.id);
  const isAdmin = Boolean(membership && isOrgAdmin(membership.role));
  if (!isAdmin) {
    const grant = await prisma.eventCollaborator.findFirst({ where: { eventId: found.event.id, userId, permissions: { has: EventPermission.REVIEW_APPLICATIONS } }, select: { id: true } });
    if (!grant || !(await staffMfaSatisfied(userId))) return null;
  }
  return { userId, organisationId: found.org.id, orgSlug: found.org.slug, eventId: found.event.id, eventSlug: found.event.slug, isAdmin };
}

/** Everyone who can review the event: REVIEW_APPLICATIONS collaborators, and the organisation's owners and admins. */
export async function eligibleReviewers(client: Prisma.TransactionClient, organisationId: string, eventId: string): Promise<{ grantees: Set<string>; admins: Set<string> }> {
  const [admins, grants] = await Promise.all([
    client.membership.findMany({ where: { organisationId, role: { in: ["OWNER", "ADMIN"] } }, select: { userId: true } }),
    client.eventCollaborator.findMany({ where: { eventId, event: { organisationId }, permissions: { has: EventPermission.REVIEW_APPLICATIONS } }, select: { userId: true } }),
  ]);
  return { grantees: new Set(grants.map((row) => row.userId)), admins: new Set(admins.map((row) => row.userId)) };
}

/**
 * A stage's reviewer pool: its panel, narrowed to people who can still
 * review; with no panel, every REVIEW_APPLICATIONS collaborator.
 */
export function stagePool(panel: readonly string[], eligible: { grantees: Set<string>; admins: Set<string> }): Set<string> {
  if (panel.length === 0) return new Set(eligible.grantees);
  return new Set(panel.filter((id) => eligible.grantees.has(id) || eligible.admins.has(id)));
}
