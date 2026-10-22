import type { Membership, MembershipRole } from "@prisma/client";
const roleRank: Record<MembershipRole, number> = { MEMBER: 0, ADMIN: 1, OWNER: 2 };

export function hasRoleAtLeast(
  role: MembershipRole,
  min: MembershipRole,
): boolean {
  return roleRank[role] >= roleRank[min];
}

export function isOrgAdmin(role: MembershipRole): boolean {
  return role === "OWNER" || role === "ADMIN";
}

export function canManageEvents(m: Membership | null): boolean {
  return m != null && isOrgAdmin(m.role);
}

export function canCreateEvent(m: Membership | null): m is Membership {
  return canManageEvents(m);
}

export function canPublishEvents(m: Membership | null): boolean {
  return canManageEvents(m);
}

/** Outgoing webhooks: endpoints, secrets, tests and delivery logs — OWNER/ADMIN only. */
export function canManageWebhooks(m: Membership | null): boolean {
  return m != null && isOrgAdmin(m.role);
}

export function canManageMembers(m: Membership | null): boolean {
  return m?.role === "OWNER";
}

export function canDeleteOrg(m: Membership | null): boolean {
  return m?.role === "OWNER";
}

export function roleLabel(role: MembershipRole) {
  return { OWNER: "Owner", ADMIN: "Admin", MEMBER: "Member" }[role];
}
