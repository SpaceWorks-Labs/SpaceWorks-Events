import Link from "next/link";
import { Download } from "lucide-react";
import type { EventDashboardContext } from "@/lib/eventDashboard/context";
import { loadMentorsPanel } from "@/lib/views/components__event-dashboard__panels__MentorsPanel";
import { buttonClasses } from "@/components/ui/button";
import { MentorConsole } from "@/components/event-dashboard/mentors/MentorConsole";
import { QueueBoard } from "@/components/mentor-desk/organiser/QueueBoard";
import { MentorsList } from "@/components/mentor-desk/organiser/MentorsList";
import { AssignmentsPanel } from "@/components/mentor-desk/organiser/AssignmentsPanel";
import { CategoriesEditor } from "@/components/mentor-desk/organiser/CategoriesEditor";
import { RoundsAdmin } from "@/components/mentor-desk/organiser/RoundsAdmin";
import { SlotEditor } from "@/components/mentor-desk/SlotEditor";
import { SubTabs, type SubTab } from "../SubTabs";
import { NoPermission } from "./shared";

/**
 * The event dashboard's Mentors tab (docs/MENTOR_DESK.md). Owners and admins
 * (`canManageMentorDesk`) run the desk: the live queue, mentors, assignments,
 * office hours, categories, rounds and the CSV. A mentor who is also on the
 * organiser side gets their own console as a further sub-tab.
 */
export async function MentorsPanel({ ctx }: { ctx: EventDashboardContext }) {
  const { permissions } = ctx;
  if (!permissions.canManageMentorDesk) {
    return permissions.canMentor ? <MentorConsole ctx={ctx} /> : <NoPermission>You do not have permission to manage the Mentor Desk for this event.</NoPermission>;
  }
  const data = await loadMentorsPanel({ ctx });
  if (!data) return <NoPermission>You do not have permission to manage the Mentor Desk for this event.</NoPermission>;
  const { view, scope } = data;
  const bounds = { start: view.settings.eventStart, end: view.settings.eventEnd };
  const csv = (kind: string, label: string) => (
    <Link href={`/api/exports/events/${encodeURIComponent(scope.eventId)}/mentor-desk?view=${kind}`} prefetch={false} className={buttonClasses({ variant: "secondary", size: "sm" })}>
      <Download aria-hidden className="size-4" />{label}
    </Link>
  );
  const items: SubTab[] = [
    { value: "mentors-queue", label: "Queue", count: view.requests.filter((r) => r.status === "OPEN").length, content: <QueueBoard scope={scope} view={view} /> },
    { value: "mentors-people", label: "Mentors", count: view.mentors.length, content: <MentorsList scope={scope} view={view} /> },
    { value: "mentors-assignments", label: "Assignments", content: <AssignmentsPanel scope={scope} view={view} /> },
    {
      value: "mentors-office-hours",
      label: "Office hours",
      content: (
        <SlotEditor scope={scope} as="organiser" timeZone={view.settings.timezone} bounds={bounds}
          mentors={view.mentors.filter((m) => m.profile).map((m) => ({ userId: m.userId, name: m.name }))}
          slots={view.slots.map((s) => ({ ...s, mentorName: s.mentorName }))} />
      ),
    },
    { value: "mentors-categories", label: "Categories", count: view.categories.length, content: <CategoriesEditor scope={scope} categories={view.categories} /> },
    { value: "mentors-rounds", label: "Rounds", count: view.rounds.length, content: <RoundsAdmin scope={scope} view={view} /> },
    {
      value: "mentors-export",
      label: "CSV",
      content: (
        <div className="flex flex-col gap-3">
          <p className="text-body-ui text-ink-secondary">Owners and admins only. Help requests are exported without their text or anyone&apos;s contact details.</p>
          <div className="flex flex-wrap gap-2">{csv("requests", "Help requests")}{csv("assignments", "Assignments")}</div>
        </div>
      ),
    },
  ];
  if (permissions.canMentor) items.push({ value: "mentors-console", label: "My console", content: <MentorConsole ctx={ctx} /> });
  return <SubTabs label="Mentor Desk sections" items={items} />;
}
