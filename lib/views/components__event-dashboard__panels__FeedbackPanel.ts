import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { loadEventDashboard, type EventDashboardContext } from "@/lib/eventDashboard/context";
import { loadFeedbackInsights } from "@/lib/eventDashboard/feedback";
import { FEEDBACK_RESPONSES_PAGE_SIZE, listFeedbackResponsesPage } from "@/lib/eventDashboard/feedbackResponses";

export async function loadFeedbackPanel({ ctx }: { ctx: EventDashboardContext; }) {
  ctx = await loadEventDashboard(ctx.organisation.slug, ctx.event.id);

  const { event, permissions, organisation } = ctx;
  // The feedback form and its responses are organisation-admin only (see app/actions/feedback-form.ts).
  if (!permissions.canManageFeedback) notFound();
  const record = await prisma.eventFeedbackForm.findUnique({ where: { eventId: event.id }, include: { fields: { orderBy: { sortOrder: "asc" } } } });
  const form = record ? { isOpen: record.isOpen, title: record.title, thankYouMessage: record.thankYouMessage, certificateEnabled: record.certificateEnabled, certificateTemplate: record.certificateTemplate } : null;
  const fields = (record?.fields ?? []).map((field) => ({
    id: field.id, key: field.key, label: field.label, type: field.type, required: field.required, sortOrder: field.sortOrder,
    options: Array.isArray(field.options) ? field.options.filter((value): value is string => typeof value === "string") : [],
  }));

  // Responses are organisation-admin only. Only answer values are read: never
  // the RSVP, attendee identity or certificate token. The individual list is
  // paged on the server (first page here, the rest via loadFeedbackResponsesPage).
  const canViewResponses = permissions.canViewFeedbackResponses;
  const [responsesPage, insights] = canViewResponses && record
    ? await Promise.all([
      listFeedbackResponsesPage({ eventId: event.id, organisationId: organisation.id }),
      loadFeedbackInsights(record.id, fields),
    ])
    : [{ responses: [], page: 1, pageCount: 1, total: 0, pageSize: FEEDBACK_RESPONSES_PAGE_SIZE }, { responseCount: 0, ratings: [], texts: [] }];

  return { event, permissions, organisation, form, fields, canViewResponses, insights, responsesPage };
}
