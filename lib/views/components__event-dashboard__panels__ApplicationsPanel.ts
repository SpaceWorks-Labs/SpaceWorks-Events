import type { EventDashboardContext } from "@/lib/eventDashboard/context";
import { loadEventDashboard } from "@/lib/eventDashboard/context";
import type { AdmissionContext } from "@/lib/admission/access";
import { loadAdmissionDashboard } from "@/lib/admission/dashboard";

function admissionContext(ctx: EventDashboardContext): AdmissionContext {
  return { userId: ctx.userId, organisationId: ctx.organisation.id, orgSlug: ctx.organisation.slug, eventId: ctx.event.id, eventSlug: ctx.event.slug, isAdmin: ctx.permissions.isAdmin };
}

/** Applications tab (docs/ADMISSION.md): owners, admins and MANAGE_REGISTRATIONS collaborators. */
export async function loadApplicationsPanel({ ctx }: { ctx: EventDashboardContext; }) {
  ctx = await loadEventDashboard(ctx.organisation.slug, ctx.event.id);
  if (!ctx.permissions.canManageApplications) return null;
  const data = await loadAdmissionDashboard(admissionContext(ctx));
  return data ? { ...data, isAdmin: ctx.permissions.isAdmin } : null;
}
