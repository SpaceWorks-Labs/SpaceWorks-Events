"use client";

import { useCallback, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Callout, EmptyState } from "@/components/ui/display";
import type { AttendeeRow } from "@/components/attendees/types";
import { ManualRsvpDialog } from "@/components/attendees/ManualRsvpDialog";
import { EditRsvpDialog } from "@/components/attendees/EditRsvpDialog";
import type { RegistrationFieldRow } from "@/components/registration/EventRegistrationFormEditor";
import { ConfirmationDialog } from "@/components/feedback/ConfirmationDialog";
import { useToast } from "@/components/feedback/ToastProvider";
import { RemoveGuestDialog } from "./GuestsPeople/RemoveGuestDialog";
import { PaymentDialog } from "@/components/attendees/PaymentDialog";
import { approveRsvp, promoteFromWaitlist, reacceptRsvp, rejectRsvp } from "@/app/actions/rsvp-lifecycle";
import { undoCheckIn } from "@/app/actions/checkin";
import { GuestRow, type GuestRowActions } from "@/components/event-dashboard/guests/GuestRow";
import { useEventTabs } from "@/components/event-dashboard/EventDashboardTabs";
import { MoveToTeamDialog } from "@/components/event-dashboard/guests/MoveToTeamDialog";
import {
  guestDisplayName,
  type GuestKindFilter,
  type GuestStatusFilter,
  type GuestTeamFilter,
} from "@/components/event-dashboard/guests/guestList";
import { useDebouncedValue, useServerPages, type ServerPageResult } from "@/components/event-dashboard/guests/useServerPages";
import { loadAttendeesPage } from "@/app/actions/guest-list";
import { attendeeViewSearchParams } from "@/lib/attendeeListQuery";
import { showingLabel } from "@/lib/keysetCursor";
import type { AttendeesPage } from "@/lib/eventDashboard/attendees";
import { viewParam, type SavedViewDto, type ViewParams } from "@/lib/savedViews";
import { useInitialViewParams, useSyncViewToUrl } from "@/components/event-dashboard/views/useViewUrl";
import { NO_COUNTS, SEARCH_DELAY_MS, type ActionResult, type GuestListTarget, type Meta, type View } from "./GuestsPeople/constants";
import { GuestFilters, GuestsHeaderActions } from "./GuestsPeople/Toolbar";
import { HelpLink } from "@/components/help/HelpLink";

export type { GuestListTarget } from "./GuestsPeople/constants";

export function GuestsPeople({
  organisationSlug,
  target,
  title = "Guests",
  timeZone,
  now,
  initialPage,
  registrationFields,
  teamMode = false,
  ticketTypes = [],
  canUndoCheckIn = true,
  savedViews,
}: {
  organisationSlug: string;
  target: GuestListTarget;
  title?: string;
  timeZone: string;
  /** Server render time (ISO) so relative labels match between server and client. */
  now: string;
  /** The first page of the unfiltered list, with its counts. */
  initialPage: AttendeesPage;
  registrationFields: RegistrationFieldRow[];
  /** TEAM event: show each guest's team, the In a team / Solo filter, route status changes to Teams, and offer Move to team. */
  teamMode?: boolean;
  /** Events that sell tickets: what a manually added guest can be given. */
  ticketTypes?: Array<{ id: string; name: string; priceMinor: number; currency: string; }>;
  /** Undo check-in is a CHECK_IN operation, separate from managing registrations. */
  canUndoCheckIn?: boolean;
  /** Saved views for this list (event dashboard only); omitted on a series date. */
  savedViews?: SavedViewDto[];
}) {
  const router = useRouter();
  const { showToast } = useToast();
  const [manualRsvpOpen, setManualRsvpOpen] = useState(false);
  // Filters live in the address bar (saved views): a link reopens the same view.
  const fromUrl = useInitialViewParams("GUESTS_PEOPLE");
  const [status, setStatus] = useState<GuestStatusFilter>(viewParam(fromUrl, "status") as GuestStatusFilter);
  const [kind, setKind] = useState<GuestKindFilter>(viewParam(fromUrl, "kind") as GuestKindFilter);
  const [team, setTeam] = useState<GuestTeamFilter>(viewParam(fromUrl, "team") as GuestTeamFilter);
  const { openTab } = useEventTabs();
  const [query, setQuery] = useState(viewParam(fromUrl, "q"));
  const [pending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editGuest, setEditGuest] = useState<AttendeeRow | null>(null);
  const [paymentGuest, setPaymentGuest] = useState<AttendeeRow | null>(null);
  const [removeGuest, setRemoveGuest] = useState<AttendeeRow | null>(null);
  const [undoGuest, setUndoGuest] = useState<AttendeeRow | null>(null);
  const [moveGuest, setMoveGuest] = useState<AttendeeRow | null>(null);

  const eventId = target.kind === "event" ? target.eventId : undefined;
  const scope = target.kind === "event" ? { eventId: target.eventId } : { eventInstanceId: target.instanceId };

  const searchedQuery = useDebouncedValue(query.trim(), SEARCH_DELAY_MS);
  const viewParams = useMemo(() => {
    const params: ViewParams = {};
    if (status !== "all") params.status = status;
    if (kind !== "all") params.kind = kind;
    if (teamMode && team !== "all") params.team = team;
    if (searchedQuery) params.q = searchedQuery;
    return params;
  }, [status, kind, team, teamMode, searchedQuery]);
  useSyncViewToUrl("GUESTS_PEOPLE", viewParams);
  const applyView = useCallback((params: ViewParams) => {
    setStatus(viewParam(params, "status") as GuestStatusFilter);
    setKind(viewParam(params, "kind") as GuestKindFilter);
    setTeam(viewParam(params, "team") as GuestTeamFilter);
    setQuery(viewParam(params, "q"));
  }, []);
  const view: View = useMemo(() => ({ status, kind, team: teamMode ? team : "all", query: searchedQuery }), [status, kind, team, teamMode, searchedQuery]);
  const viewKey = JSON.stringify(view);
  const isDefaultView = view.status === "all" && view.kind === "all" && view.team === "all" && !view.query;
  const initial = useMemo(
    () => ({ rows: initialPage.rows as AttendeeRow[], nextCursor: initialPage.nextCursor, meta: { counts: initialPage.counts ?? NO_COUNTS, total: initialPage.total ?? 0, matching: initialPage.matching ?? 0 } as Meta }),
    [initialPage],
  );
  const scopeIds = useMemo(() => (target.kind === "event" ? { eventId: target.eventId } : { eventInstanceId: target.instanceId }), [target]);
  const fetchPage = useCallback(
    async (current: View, cursor: string | null): Promise<ServerPageResult<AttendeeRow, Meta>> => {
      const res = await loadAttendeesPage({ organisationSlug, ...scopeIds, ...current, cursor });
      if (!res.ok || !res.data) return { ok: false, error: res.ok ? "Could not load guests." : res.error };
      const { rows, nextCursor, counts, total, matching } = res.data;
      return { ok: true, page: { rows, nextCursor, meta: counts && total != null && matching != null ? { counts, total, matching } : null } };
    },
    [organisationSlug, scopeIds],
  );
  const list = useServerPages<AttendeeRow, View, Meta>({ initial, view, viewKey, isDefaultView, delayMs: 0, fetchPage, keyOf: (row) => row.id });
  // The chips count the whole event; the list, its label and the exports follow the search and dropdowns.
  const { counts, total, matching } = list.meta;
  const shownTotal = matching;
  // Both exports carry the list's current filters and search, so they hold
  // every matching registration, not only the rows loaded here.
  const viewQuery = attendeeViewSearchParams(view);
  const emailExportHref = eventId ? `/api/exports/events/${eventId}/attendee-emails${viewQuery ? `?${viewQuery}` : ""}` : null;
  const csvExportHref = eventId ? `/api/exports/events/${eventId}/attendees${viewQuery ? `?${viewQuery}` : ""}` : null;

  function run<R extends ActionResult>(guest: AttendeeRow, action: () => Promise<R>, success: string | ((res: R) => string)) {
    setBusyId(guest.id);
    startTransition(async () => {
      const res = await action();
      setBusyId(null);
      if (!res.ok) {
        showToast(res.error, "error");
        return;
      }
      showToast(typeof success === "string" ? success : success(res), "success");
      router.refresh();
    });
  }

  const actions: GuestRowActions = {
    approve: (guest) => run(guest, () => approveRsvp({ organisationSlug, rsvpId: guest.id, ...scope }), "Approved"),
    decline: (guest) => run(guest, () => rejectRsvp({ organisationSlug, rsvpId: guest.id, ...scope }), "Declined"),
    promote: (guest) => run(guest, () => promoteFromWaitlist({ organisationSlug, rsvpId: guest.id, ...scope }), "Spot given"),
    reaccept: (guest) => run(guest, () => reacceptRsvp({ organisationSlug, rsvpId: guest.id, ...scope }), (res) => {
      const status = "data" in res ? res.data?.status : undefined;
      if (status === "PAYMENT_REQUESTED") return "Re-accepted. They've been sent a payment link; their ticket confirms once they pay.";
      return status === "WAITLISTED" ? "Re-accepted. The event is full, so they're on the waitlist." : "Re-accepted";
    }),
    copyTicket: async (guest) => {
      try {
        await navigator.clipboard.writeText(guest.ticketUrl);
        showToast("Ticket link copied", "success");
      } catch {
        showToast("Could not copy", "error");
      }
    },
    edit: (guest) => setEditGuest(guest),
    undoCheckIn: eventId && canUndoCheckIn ? (guest) => setUndoGuest(guest) : undefined,
    remove: (guest) => setRemoveGuest(guest),
    // Orders on an event, or on a series date or pass, are refunded the same way.
    payment: (guest) => setPaymentGuest(guest),
    openTeams: teamMode && target.kind === "event" ? () => openTab("guests", "teams") : undefined,
    // The dialog searches the event's teams on the server; the move itself is re-checked there.
    moveToTeam: teamMode && target.kind === "event" ? (guest) => setMoveGuest(guest) : undefined,
  };

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1">
          <h2 className="text-h4 text-ink">{title}</h2>
          <HelpLink article="guests/guest-list" />
        </div>
        {target.kind === "event" ? (
          <GuestsHeaderActions
            organisationSlug={organisationSlug}
            eventId={target.eventId}
            savedViews={savedViews}
            viewParams={viewParams}
            applyView={applyView}
            teamMode={teamMode}
            emailExportHref={emailExportHref}
            csvExportHref={csvExportHref}
            shownTotal={shownTotal}
            setManualRsvpOpen={setManualRsvpOpen}
          />
        ) : null}
      </div>

      {total === 0 && list.rows.length === 0 ? (
        <EmptyState mood="sleepy" title="No guests yet.">
          Registrations appear here as people sign up.{eventId ? " You can also add a guest yourself." : null}
        </EmptyState>
      ) : (
        <>
          <GuestFilters
            status={status}
            setStatus={setStatus}
            counts={counts}
            kind={kind}
            setKind={setKind}
            teamMode={teamMode}
            team={team}
            setTeam={setTeam}
            query={query}
            setQuery={setQuery}
          />

          {list.error ? <Callout tone="danger" role="alert">{list.error}</Callout> : null}

          {list.loading === "replace" ? (
            <p role="status" className="text-body-ui text-ink-muted">Loading guests…</p>
          ) : list.rows.length === 0 ? (
            <EmptyState>{view.query ? "No guests match that search." : "No guests in this view."}</EmptyState>
          ) : (
            <ul id={list.listId} aria-label="Guests" aria-busy={list.loading != null} className="flex flex-col gap-2">
              {list.rows.map((guest) => (
                <GuestRow key={guest.id} guest={guest} timeZone={timeZone} now={now} busy={pending && busyId === guest.id} disabled={pending} actions={actions} />
              ))}
            </ul>
          )}

          {list.rows.length > 0 && list.loading !== "replace" ? (
            <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-ink-secondary">
              <span aria-live="polite">{showingLabel(list.rows.length, Math.max(shownTotal, list.rows.length), shownTotal === 1 ? "guest" : "guests")}</span>
              {list.nextCursor ? (
                <Button size="sm" variant="secondary" loading={list.loading === "more"} loadingLabel="Loading…" onClick={() => void list.loadMore()}>
                  Load more guests
                </Button>
              ) : null}
            </div>
          ) : null}
        </>
      )}

      {paymentGuest?.order ? (
        <PaymentDialog
          organisationSlug={organisationSlug}
          target={target.kind === "event" ? { eventId: target.eventId } : { seriesId: target.seriesId }}
          guest={paymentGuest}
          onClose={() => setPaymentGuest(null)}
          onDone={(message) => {
            setPaymentGuest(null);
            showToast(message, "success");
            router.refresh();
          }}
        />
      ) : null}

      {manualRsvpOpen && eventId ? <ManualRsvpDialog organisationSlug={organisationSlug} eventId={eventId} fields={registrationFields} ticketTypes={ticketTypes} onClose={() => setManualRsvpOpen(false)} onAdded={() => router.refresh()} /> : null}

      {moveGuest && eventId ? (
        <MoveToTeamDialog
          organisationSlug={organisationSlug}
          eventId={eventId}
          person={{ rsvpId: moveGuest.id, name: guestDisplayName(moveGuest), teamId: moveGuest.team?.id ?? null }}
          onClose={() => setMoveGuest(null)}
          onMoved={() => router.refresh()}
        />
      ) : null}

      {editGuest ? (
        <EditRsvpDialog
          organisationSlug={organisationSlug}
          {...scope}
          attendee={editGuest}
          fields={registrationFields}
          onClose={() => setEditGuest(null)}
          onUpdated={() => router.refresh()}
        />
      ) : null}

      <ConfirmationDialog
        open={Boolean(undoGuest)}
        title="Undo check-in?"
        message={`Mark ${undoGuest ? guestDisplayName(undoGuest) : "this guest"} as not checked in?`}
        confirmLabel="Undo check-in"
        destructive={false}
        loading={pending}
        onCancel={() => setUndoGuest(null)}
        onConfirm={() => {
          if (!undoGuest || !eventId) return;
          const guest = undoGuest;
          setUndoGuest(null);
          run(guest, () => undoCheckIn({ organisationSlug, eventId, rsvpId: guest.id }), "Check-in undone");
        }}
      />

      <RemoveGuestDialog
        organisationSlug={organisationSlug}
        scope={scope}
        removeGuest={removeGuest}
        setRemoveGuest={setRemoveGuest}
        pending={pending}
        startTransition={startTransition}
        showToast={showToast}
        router={router}
      />
    </div>
  );
}
