import { EventPermission, RegistrationFieldType, type Prisma } from "@prisma/client";
import { auth } from "@/lib/auth";
import { recordAuditEvent } from "@/lib/audit";
import { csvStreamResponse, exportFilename, exportFilterNames, exportNotFound } from "@/lib/csvExport";
import { minorToDecimalString } from "@/lib/payments/money";
import { prisma } from "@/lib/db";
import { canAccessEvent } from "@/lib/eventAccess";
import { getRequestOrigin } from "@/lib/publicUrl";
import { attendeeBaseWhere, attendeeStatusWhere, parseAttendeeViewSearchParams, type AttendeeListView } from "@/lib/attendeeListQuery";
import { attendanceCsvCells } from "@/lib/attendeeAttendance";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const EXPORT_BATCH_SIZE = 500;

/*
 * The attendee CSV. Without query parameters it holds every registration of
 * the event (the check-in desk's "Export attendance" and the unfiltered
 * Guests · People list). Guests · People's "Export CSV" adds the list's
 * current filters (`status`, `kind`, `team`, `q`, parsed exactly as the
 * list's own query by lib/attendeeListQuery.ts), so the file holds every
 * matching registration, not only the rows loaded in the browser. Same
 * columns either way; any malformed parameter is the same empty 404 as a
 * denial.
 */

function isFiltered(view: AttendeeListView) {
  return view.status !== "all" || view.kind !== "all" || view.team !== "all" || view.attendance !== "all" || Boolean(view.query);
}

type StoredAnswer = { fieldId: string; valueText: string | null; valueBool: boolean | null; valueNumber: number | null; valueDate: Date | null };

function answerValue(answer: StoredAnswer) {
  return answer.valueText
    ?? (answer.valueBool == null ? null : answer.valueBool ? "Yes" : "No")
    ?? (answer.valueNumber == null ? null : String(answer.valueNumber))
    ?? answer.valueDate?.toISOString().slice(0, 10)
    ?? "";
}

type AnswerColumn = { id: string; multi: boolean; rank: Map<string, number> };

/** One column per question; a multi-select's options are ranked in the question's order. */
function answerColumns(fields: ReadonlyArray<{ id: string; type: RegistrationFieldType; options: Prisma.JsonValue }>): AnswerColumn[] {
  return fields.map((field) => {
    const options = Array.isArray(field.options) ? field.options.filter((option): option is string => typeof option === "string").map((option) => option.trim()) : [];
    return { id: field.id, multi: field.type === RegistrationFieldType.MULTI_SELECT, rank: new Map(options.map((option, index) => [option, index])) };
  });
}

/**
 * One cell per question. A multi-select keeps one answer row per choice, so
 * its cell joins every choice with "; ": the question's options in their
 * order, then any other text ("Other", or an option since removed) by value.
 */
function answerCells(columns: AnswerColumn[], answers: ReadonlyArray<StoredAnswer>) {
  const byField = new Map<string, string[]>();
  for (const answer of answers) byField.set(answer.fieldId, [...(byField.get(answer.fieldId) ?? []), answerValue(answer)]);
  return columns.map((column) => {
    const values = byField.get(column.id) ?? [];
    if (!column.multi) return values[0] ?? "";
    const rank = (value: string) => column.rank.get(value) ?? column.rank.size;
    return values.sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0)).join("; ");
  });
}

/** Team name and role for one registration; solo registrants get an empty team and "Solo", crew "Crew". */
function teamCells(rsvp: { id: string; isCrew: boolean; team?: { name: string; leaderRsvpId: string | null } | null }) {
  if (rsvp.isCrew) return ["", "Crew"];
  if (!rsvp.team) return ["", "Solo"];
  return [rsvp.team.name, rsvp.team.leaderRsvpId === rsvp.id ? "Leader" : "Member"];
}

type RouteContext = { params: Promise<{ eventId: string }> };

export async function GET(request: Request, context: RouteContext) {
  const session = await auth();
  if (!session?.user?.id) return exportNotFound();

  const { eventId } = await context.params;
  if (!eventId || eventId.length > 128) return exportNotFound();
  const view = parseAttendeeViewSearchParams(new URL(request.url).searchParams);
  if (!view) return exportNotFound();
  const event = await prisma.event.findUnique({
    where: { id: eventId },
    select: {
      id: true,
      title: true,
      organisationId: true,
      registrationMode: true,
      registrationForm: {
        select: { fields: { select: { id: true, label: true, type: true, options: true }, orderBy: { sortOrder: "asc" } } },
      },
      // One column per custom check-in list, after the registration answers,
      // so existing columns keep their positions.
      checkInLists: {
        select: { id: true, name: true, archived: true },
        orderBy: [{ archived: "asc" }, { sortOrder: "asc" }, { createdAt: "asc" }],
      },
    },
  });
  if (!event) return exportNotFound();

  // Organisation owners/admins, or anyone (member or not) holding the exact
  // MANAGE_REGISTRATIONS grant on this event, as in lib/eventDashboard/capabilities.ts.
  if (!(await canAccessEvent({ userId: session.user.id, organisationId: event.organisationId, eventId: event.id, permission: EventPermission.MANAGE_REGISTRATIONS }))) return exportNotFound();

  const fields = event.registrationForm?.fields ?? [];
  const columns = answerColumns(fields);
  // TEAM events add Team and Team role columns (docs/TEAMS.md); other exports keep their columns.
  const teamColumns = event.registrationMode === "TEAM";
  const lists = event.checkInLists;
  const origin = await getRequestOrigin();
  // Attendance confirmation (docs/ATTENDANCE.md): "Not asked" only once someone at this event has been asked, as in Guests · People.
  const attendanceAsked = (await prisma.attendanceCheck.findFirst({ where: { eventId: event.id }, select: { id: true } })) != null;
  // Unfiltered: every registration, as before. Filtered: the People list's
  // own conditions, with the organisation re-checked in the same query.
  const where: Prisma.RSVPWhereInput = isFiltered(view)
    ? { AND: [attendeeBaseWhere({ kind: "event", eventId: event.id, organisationId: event.organisationId }, view, { teamMode: teamColumns }), attendeeStatusWhere(view.status)] }
    : { eventId: event.id };
  await recordAuditEvent({
    action: "ATTENDEE_LIST_EXPORTED",
    actorUserId: session.user.id,
    organisationId: event.organisationId,
    targetType: "Event",
    targetId: event.id,
    // Filter names only; the search text can contain personal data.
    metadata: {
      surface: "people",
      filters: exportFilterNames({ status: view.status !== "all", kind: view.kind !== "all", team: teamColumns && view.team !== "all", attendance: view.attendance !== "all", search: Boolean(view.query) }),
    },
  });

  return csvStreamResponse({
    header: ["Name", "Email", "Status", ...(teamColumns ? ["Team", "Team role"] : []), "Registration Date", "Checked In At", "Ticket URL", "Ticket", "Order", "Order status", "Order total", ...fields.map((field) => field.label), ...lists.map((list) => `Check-in: ${list.name}${list.archived ? " (archived)" : ""}`), "Attendance confirmation", "Attendance note"],
    filename: exportFilename("attendees", event.title),
    errorMessage: "Unable to export attendee list.",
    batches: async function* () {
      let cursor: string | undefined;

      while (true) {
        const rsvps = await prisma.rSVP.findMany({
          where,
          orderBy: { id: "asc" },
          take: EXPORT_BATCH_SIZE,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
          include: {
            user: { select: { name: true, email: true } },
            ticketType: { select: { name: true } },
            order: { select: { reference: true, status: true, totalMinor: true, currency: true } },
            answers: { select: { fieldId: true, valueText: true, valueBool: true, valueNumber: true, valueDate: true } },
            team: { select: { name: true, leaderRsvpId: true } },
            checkInListRecords: { select: { listId: true, checkedInAt: true } },
            // The reply, its note and a kept paid place only; the check's token hash is never read.
            attendanceCheck: { select: { response: true, note: true, releaseOutcome: true } },
          },
        });
        if (!rsvps.length) break;

        const rows = rsvps.map((rsvp) => {
          const listCheckIns = new Map(rsvp.checkInListRecords.map((record) => [record.listId, record.checkedInAt.toISOString()]));
          return [
            rsvp.user?.name ?? rsvp.guestName ?? "",
            rsvp.user?.email ?? rsvp.guestEmail ?? "",
            rsvp.status,
            ...(teamColumns ? teamCells(rsvp) : []),
            rsvp.createdAt.toISOString(),
            rsvp.checkedInAt?.toISOString() ?? "",
            `${origin}/ticket/${rsvp.checkInToken}`,
            // Crew tickets (docs/CREW.md) are free and have no ticket type: marked in the Ticket column.
            rsvp.isCrew ? "Crew" : rsvp.ticketType?.name ?? "",
            rsvp.order?.reference ?? "",
            rsvp.order?.status ?? "",
            rsvp.order ? `${rsvp.order.currency} ${minorToDecimalString(rsvp.order.totalMinor, rsvp.order.currency)}` : "",
            ...answerCells(columns, rsvp.answers),
            ...lists.map((list) => listCheckIns.get(list.id) ?? ""),
            ...attendanceCsvCells(rsvp, { showNotAsked: attendanceAsked }),
          ];
        });
        yield rows;
        cursor = rsvps.at(-1)?.id;
      }
    },
  });
}
