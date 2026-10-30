import type { Membership, MembershipRole } from "@prisma/client";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { requireStaffMfa, staffMfaSatisfied } from "@/lib/staffMfa";
import type { Session } from "next-auth";


export async function getMembership(
  userId: string,
  organisationId: string,
): Promise<Membership | null> {
  const membership = await prisma.membership.findUnique({
    where: {
      userId_organisationId: { userId, organisationId },
    },
  });
  // Staff powers wait until the signed-in member has passed an authenticator check.
  if (membership && !(await staffMfaSatisfied(userId))) return null;
  return membership;
}

/** Read from the database for mutation gates; session JWTs can be stale. */
export async function isUserEmailVerified(userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { emailVerified: true } });
  return user?.emailVerified != null;
}

export async function requireAuth(): Promise<Session & { user: { id: string; }; }> {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  return session as Session & { user: { id: string; }; };
}


function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}


/**
 * The user's email when they are the configured, verified super admin signed
 * in with the password (`session.authMethod`), else null. A Google sign-in, an
 * app session or a token from before sign-in methods were recorded never
 * counts. Pages and actions use `requireSuperAdminMfa`; this is for readers
 * that only need to know (the guide's section list, lib/views/app__help__layout.ts).
 */
export async function superAdminEmailFor(session: Pick<Session, "user" | "authMethod">): Promise<string | null> {
  const configured = process.env.SUPER_ADMIN_EMAIL;
  if (!configured || session.authMethod !== "credentials") return null;
  const userId = session.user.id;
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, emailVerified: true },
  });
  if (!user?.email || !user.emailVerified) return null;
  return normalizeEmail(user.email) === normalizeEmail(configured) ? user.email : null;
}

/**
 * Instance-wide super-admin gate.
 *
 * Access is granted only when `process.env.SUPER_ADMIN_EMAIL` is set and matches
 * the current signed-in user's email (case-insensitive).
 *
 * We return `notFound()` on mismatch to avoid leaking panel existence.
 */
export async function requireSuperAdmin(): Promise<
  Session & { user: { id: string; email: string; }; }
> {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const userEmail = await superAdminEmailFor(session);
  if (!userEmail) notFound();

  return {
    ...session,
    user: { ...session.user, id: session.user.id, email: userEmail },
  } as Session & { user: { id: string; email: string; }; };
}

/**
 * The instance admin panel's gate. The super admin signs in with email and
 * password only (the password is set only from the server); the sign-in's
 * own checks still apply: new-device email codes, lockouts and IP blocking.
 */
export async function requireSuperAdminMfa() {
  return requireSuperAdmin();
}

export type OrgAccessContext = {
  organisation: { id: string; slug: string; name: string; };
  membership: Membership;
  userId: string;
};

export async function requireOrgRole(
  orgSlug: string,
  minRole: MembershipRole,
): Promise<OrgAccessContext> {
  const session = await requireAuth();
  const org = await prisma.organisation.findUnique({
    where: { slug: orgSlug },
  });
  if (!org) redirect("/dashboard");

  await requireStaffMfa(session.user.id, `/dashboard/${orgSlug}`);
  const membership = await getMembership(session.user.id, org.id);
  if (!membership) redirect("/dashboard");
  if (!hasRoleAtLeast(membership.role, minRole)) {
    redirect(`/dashboard/${orgSlug}`);
  }

  return {
    organisation: { id: org.id, slug: org.slug, name: org.name },
    membership,
    userId: session.user.id,
  };
}

export async function requireOrgMembership(
  orgSlug: string,
): Promise<OrgAccessContext> {
  return requireOrgRole(orgSlug, "MEMBER");
}

/** Dashboard access may also be granted by an event/series collaborator assignment. */
export async function requireOrgDashboardAccess(orgSlug: string): Promise<Omit<OrgAccessContext, "membership"> & { membership: Membership | null; isCollaborator: boolean; }> {
  const session = await requireAuth();
  const org = await prisma.organisation.findUnique({ where: { slug: orgSlug } });
  if (!org) redirect("/dashboard");
  await requireStaffMfa(session.user.id, `/dashboard/${orgSlug}`);
  const membership = await getMembership(session.user.id, org.id);
  if (membership) return { organisation: { id: org.id, slug: org.slug, name: org.name }, membership, userId: session.user.id, isCollaborator: false };
  const grant = await prisma.eventCollaborator.findFirst({ where: { userId: session.user.id, OR: [{ event: { organisationId: org.id } }, { series: { organisationId: org.id } }] }, select: { id: true } });
  if (!grant) redirect("/dashboard");
  return { organisation: { id: org.id, slug: org.slug, name: org.name }, membership: null, userId: session.user.id, isCollaborator: true };
}

export { hasRoleAtLeast, isOrgAdmin, canManageEvents, canCreateEvent, canPublishEvents, canManageWebhooks, canManageMembers, canDeleteOrg } from "@/lib/permissionRoles";

import { hasRoleAtLeast } from "./permissionRoles";
