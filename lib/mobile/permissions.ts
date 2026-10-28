import type { EventPermission, MembershipRole } from "@prisma/client";
import { eventCapabilities } from "@/lib/eventDashboard/capabilities";
import { isOrgAdmin } from "@/lib/permissionRoles";
import type { EventPermissionsDto } from "@/lib/mobile/schemas";

/*
 * Pure permission flags for the mobile organiser UI, derived from the same
 * source as the web dashboard (lib/eventDashboard/capabilities.ts), so a
 * control the website shows is the control the app shows. Every action still
 * re-checks on the server. `role` is the caller's organisation role (null for
 * a collaborator who is not a member); `grant` their event grant.
 */
export function eventPermissionsFor(
  role: MembershipRole | null,
  grant: readonly EventPermission[],
  options: { submissionsEnabled?: boolean } = {},
): EventPermissionsDto {
  const can = eventCapabilities(role, grant);
  return {
    checkIn: can.canCheckIn,
    // Space Works lets the MANAGE_REGISTRATIONS grant manage guests, as on the web.
    manageRegistrations: can.canManageRegistrations,
    sendEmails: can.canSendEmails,
    schedule: can.canManageSchedule,
    manageFeedback: can.canManageFeedback,
    // The same rule as the core (canPublishEvents: organisation OWNER/ADMIN).
    manageRegistrationWindow: role !== null && isOrgAdmin(role),
    // The judging workspace, once the event takes submissions.
    judge: Boolean(options.submissionsEnabled) && can.canJudge,
    checkInToLists: can.canCheckInToLists,
    manageOrders: can.canManageRegistrations,
    // Anyone on the event dashboard files their own claims (docs/FINANCE.md).
    fileClaims: role !== null || grant.length > 0,
    manageFinance: can.isAdmin,
  };
}

/** Guests and counts are visible to registration managers and to the check-in desk (which already sees the roster). */
export function canSeeGuests(permissions: EventPermissionsDto) {
  return permissions.manageRegistrations || permissions.checkIn;
}
