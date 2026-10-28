import type { EventDashboardContext } from "@/lib/eventDashboard/context";
import { loadApplicationsPanel } from "@/lib/views/components__event-dashboard__panels__ApplicationsPanel";
import { ApplicationSettings } from "@/components/event-dashboard/admission/ApplicationSettings";
import { ApplicationsList } from "@/components/event-dashboard/admission/ApplicationsList";
import { AssignCard } from "@/components/event-dashboard/admission/AssignCard";
import { OffersCard } from "@/components/event-dashboard/admission/OffersCard";
import { ReviewWorkspace } from "@/components/event-dashboard/admission/ReviewWorkspace";
import { StagesCard } from "@/components/event-dashboard/admission/StagesCard";
import { SubTabs, type SubTab } from "../SubTabs";
import { NoPermission } from "./shared";

/**
 * The event dashboard's Applications tab (docs/ADMISSION.md), on events that
 * take applications. Organisers (owners, admins, MANAGE_REGISTRATIONS) get
 * the overview and settings, stages and panels, review and decisions,
 * reviewer assignment, and offers and the waitlist; anyone who reviews gets
 * their review workspace too.
 */
export async function ApplicationsPanel({ ctx }: { ctx: EventDashboardContext }) {
  const { permissions } = ctx;
  const review: SubTab | null = permissions.canReviewApplications ? { value: "applications-review", label: "My reviews", content: <ReviewWorkspace ctx={ctx} /> } : null;
  if (!permissions.canManageApplications) {
    return review ? <ReviewWorkspace ctx={ctx} /> : <NoPermission>You do not have permission to manage this event&apos;s applications.</NoPermission>;
  }
  const data = await loadApplicationsPanel({ ctx });
  if (!data) return <NoPermission>You do not have permission to manage this event&apos;s applications.</NoPermission>;
  const scope = { organisationSlug: ctx.organisation.slug, eventId: ctx.event.id };
  const items: SubTab[] = [
    { value: "applications-overview", label: "Overview", content: <ApplicationSettings scope={scope} data={data} isAdmin={data.isAdmin} /> },
    { value: "applications-list", label: "Review and decide", count: data.draftCount || undefined, content: <ApplicationsList scope={scope} data={data} /> },
    { value: "applications-stages", label: "Stages", content: <StagesCard scope={scope} data={data} /> },
    { value: "applications-reviewers", label: "Reviewers", content: <AssignCard scope={scope} data={data} /> },
    { value: "applications-offers", label: "Offers and waitlist", content: <OffersCard data={data} /> },
    ...(review ? [review] : []),
  ];
  return <SubTabs label="Application sections" items={items} />;
}
