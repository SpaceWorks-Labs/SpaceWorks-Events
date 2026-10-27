import { notFound } from "next/navigation";
import { EventPermission } from "@prisma/client";
import { prisma } from "@/lib/db";
import { canAccessEvent, canViewEventDashboard } from "@/lib/eventAccess";
import { isOrgAdmin, requireAuth, requireOrgDashboardAccess, requireOrgMembership, requireOrgRole } from "@/lib/permissions";
import { requireStaffMfa } from "@/lib/staffMfa";
import { loadProgramme } from "@/lib/memberIds/data";
import { editableDesign, resolveDesignActor } from "@/lib/ticketDesign/access";

/*
 * Dashboard route guards, as view readers so the split frontend runs them on
 * the backend too. lib/dashboardGuards.ts wraps each in React `cache`, and the
 * layout beside every dashboard `loading.tsx` awaits one.
 *
 * A segment's `loading.tsx` is a Suspense boundary around its page and every
 * segment below it, but not around its own layout. Once that fallback renders,
 * the response has started streaming with a 200 status, so a `notFound()` or
 * `redirect()` thrown inside the boundary can no longer change it. Running the
 * page's access check in the layout beside the `loading.tsx` resolves it
 * before streaming starts, so no access, the wrong organisation, another
 * organisation's event, an unknown id and judge-only collaborators on
 * non-judging pages get a real 404 (or 307). Pages keep their own checks as
 * defence in depth; these mirror them exactly and never grant more. They
 * return nothing but `true`.
 *
 * `tests/unit/dashboard-loading-boundaries.test.ts` pins where loading screens
 * may live and which guard each one's layout awaits.
 */

type OrgParams = { params: Promise<{ orgSlug: string; }>; };
type EventParams = { params: Promise<{ orgSlug: string; eventId: string; }>; };

/** The dashboard home: signed in, with the staff authenticator check passed. */
export async function guardDashboardHome() {
  const session = await requireAuth();
  await requireStaffMfa(session.user.id, "/dashboard");
  return true;
}

/** Organisation dashboard access: membership or an event/series collaborator grant. */
export async function guardOrgDashboard({ params }: OrgParams) {
  const { orgSlug } = await params;
  await requireOrgDashboardAccess(orgSlug);
  return true;
}

/** Any organisation member (members list, member IDs). */
export async function guardOrgMember({ params }: OrgParams) {
  const { orgSlug } = await params;
  await requireOrgMembership(orgSlug);
  return true;
}

/** Organisation owners and admins (settings, webhooks, chat, ticket design library). */
export async function guardOrgAdmin({ params }: OrgParams) {
  const { orgSlug } = await params;
  await requireOrgRole(orgSlug, "ADMIN");
  return true;
}

/** Organisation owners (API clients, own email server, payments). */
export async function guardOrgOwner({ params }: OrgParams) {
  const { orgSlug } = await params;
  await requireOrgRole(orgSlug, "OWNER");
  return true;
}

async function eventDashboardAccess(orgSlug: string, eventId: string) {
  const access = await requireOrgDashboardAccess(orgSlug);
  const event = await prisma.event.findFirst({ where: { id: eventId, organisationId: access.organisation.id }, select: { id: true } });
  if (!event) notFound();
  if (!access.membership && !(await canViewEventDashboard({ userId: access.userId, organisationId: access.organisation.id, eventId: event.id }))) notFound();
  return { access, eventId: event.id };
}

/** The event belongs to the organisation and the viewer may open its dashboard (a JUDGE-only grant counts). */
export async function guardEventDashboard({ params }: EventParams) {
  const { orgSlug, eventId } = await params;
  await eventDashboardAccess(orgSlug, eventId);
  return true;
}

/** The check-in desk and badges: organisation OWNER/ADMIN or the CHECK_IN grant. */
export async function guardEventCheckIn({ params }: EventParams) {
  const { orgSlug, eventId } = await params;
  const { access } = await eventDashboardAccess(orgSlug, eventId);
  const isAdmin = Boolean(access.membership && isOrgAdmin(access.membership.role));
  if (!isAdmin && !(await canAccessEvent({ userId: access.userId, organisationId: access.organisation.id, eventId, permission: EventPermission.CHECK_IN }))) notFound();
  return true;
}

/** The event schedule: PUBLISH_AND_SCHEDULE, exactly as the page checks it. */
export async function guardEventSchedule({ params }: EventParams) {
  const { orgSlug, eventId } = await params;
  const { access } = await eventDashboardAccess(orgSlug, eventId);
  if (!(await canAccessEvent({ userId: access.userId, organisationId: access.organisation.id, eventId, permission: EventPermission.PUBLISH_AND_SCHEDULE }))) notFound();
  return true;
}

/** The series belongs to the organisation and the viewer may open its dashboard. */
export async function guardSeriesDashboard({ params }: { params: Promise<{ orgSlug: string; seriesId: string; }>; }) {
  const { orgSlug, seriesId } = await params;
  const access = await requireOrgDashboardAccess(orgSlug);
  const series = await prisma.eventSeries.findFirst({ where: { id: seriesId, organisationId: access.organisation.id }, select: { id: true } });
  if (!series) notFound();
  if (!access.membership && !(await canViewEventDashboard({ userId: access.userId, organisationId: access.organisation.id, eventSeriesId: series.id }))) notFound();
  return true;
}

/** An organisation admin opening one of the organisation's own webhook endpoints. */
export async function guardWebhookEndpoint({ params }: { params: Promise<{ orgSlug: string; endpointId: string; }>; }) {
  const { orgSlug, endpointId } = await params;
  const { organisation } = await requireOrgRole(orgSlug, "ADMIN");
  const endpoint = await prisma.webhookEndpoint.findFirst({ where: { id: endpointId, organisationId: organisation.id }, select: { id: true } });
  if (!endpoint) notFound();
  return true;
}

/** A member opening one of the organisation's own member ID programmes. */
export async function guardIdProgramme({ params }: { params: Promise<{ orgSlug: string; programmeId: string; }>; }) {
  const { orgSlug, programmeId } = await params;
  const { organisation } = await requireOrgMembership(orgSlug);
  if (!(await loadProgramme(organisation.id, programmeId))) notFound();
  return true;
}

/** The ticket designer: a library design for owners and admins, or an event's for its EDIT_DETAILS editors. */
export async function guardTicketDesign({ params }: { params: Promise<{ orgSlug: string; designId: string; }>; }) {
  const { orgSlug, designId } = await params;
  const session = await requireAuth();
  await requireStaffMfa(session.user.id, `/dashboard/${orgSlug}/ticket-designs/${designId}`);
  const actor = await resolveDesignActor(session.user.id, orgSlug);
  if (!actor || !(await editableDesign(actor, designId))) notFound();
  return true;
}
