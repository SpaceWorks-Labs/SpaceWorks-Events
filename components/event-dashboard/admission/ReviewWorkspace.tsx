import type { EventDashboardContext } from "@/lib/eventDashboard/context";
import { loadReviewWorkspace } from "@/lib/views/components__event-dashboard__admission__ReviewWorkspace";
import { Card, CardHeader } from "@/components/ui/display";
import { HelpLink } from "@/components/help/HelpLink";
import { ReviewQueue } from "./ReviewQueue";

/**
 * The review workspace (docs/ADMISSION.md "Reviewing"): the applications
 * assigned to the signed-in reviewer, open stages first. A blind stage shows
 * no names, emails, phone numbers or team names.
 */
export async function ReviewWorkspace({ ctx }: { ctx: EventDashboardContext }) {
  const items = await loadReviewWorkspace({ ctx });
  if (!items) return null;
  return (
    <Card>
      <CardHeader title="Applications to review" description="Score each application on its stage's criteria. Reviews can't be changed once submitted." action={<HelpLink article="applications/reviewing" />} />
      <ReviewQueue scope={{ organisationSlug: ctx.organisation.slug, eventId: ctx.event.id }} items={items} />
    </Card>
  );
}
