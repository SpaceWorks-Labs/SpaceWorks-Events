import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { prisma } from "@/lib/db";
import { safeTimeZone } from "@/lib/timeZone";
import { safeHttpUrl } from "@/lib/safeHttpUrl";
import { type CalendarEvent } from "@/lib/calendarInvite";
import { INK_ACCENT } from "@/lib/theme/accent";
import { type ChipTone } from "@/components/ui/display";
import { PaymentStatus } from "@prisma/client";
import { refreshOrderFromProvider } from "@/lib/payments/checkout";
import { isActiveHold } from "@/lib/payments/holds";
import { loadTicketTeamSection, ticketSubmissionMode, ticketViewerId } from "@/lib/teamTicketSection";
import { loadTicketClaims } from "@/lib/claims/ticketView";
import { loadTicketApplication } from "@/lib/admission/ticketView";
import { ticketDesignFor } from "@/lib/ticketDesign/resolve";
import { formatMoney } from "@/lib/payments/money";
type Props = {
  params: Promise<{ token: string; }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};
function validToken(value: string | undefined) {
  const token = value?.trim() ?? "";
  return /^[A-Za-z0-9_-]{8,128}$/.test(token) ? token : null;
}
export async function loadRouteMetadata({ params }: Props): Promise<Metadata> {
  const { token } = await params;
  const safeToken = validToken(token);
  if (!safeToken) return { title: "Your Ticket", robots: { index: false, follow: false }, referrer: "no-referrer" };
  const rsvp = await prisma.rSVP.findUnique({
    where: { checkInToken: safeToken },
    select: {
      event: { select: { title: true } },
      eventInstance: { select: { series: { select: { title: true } } } },
    },
  });
  const title = rsvp?.event?.title ?? rsvp?.eventInstance?.series?.title;
  return {
    title: title ? `Ticket · ${title}` : "Your Ticket",
    robots: { index: false, follow: false },
    referrer: "no-referrer",
  };
}
function displayName(r: {
  user: { name: string | null; } | null;
  guestName?: string | null;
  guestEmail: string | null;
}) {
  const n = r.user?.name?.trim();
  if (n) return n;
  const gn = r.guestName?.trim();
  if (gn) return gn;
  if (r.guestEmail) return r.guestEmail.split("@")[0] ?? "Guest";
  return "Guest";
}
function statusLabel(status: string) {
  switch (status) {
    case "CONFIRMED":
      return { label: "Confirmed", tone: "success" as ChipTone };
    case "WAITLISTED":
      return { label: "Waitlisted", tone: "warning" as ChipTone };
    case "PENDING_APPROVAL":
      return { label: "Pending approval", tone: "warning" as ChipTone };
    case "REJECTED":
      return { label: "Rejected", tone: "danger" as ChipTone };
    case "PENDING_PAYMENT":
      return { label: "Payment pending", tone: "warning" as ChipTone };
    default:
      return { label: status, tone: "neutral" as ChipTone };
  }
}
export async function loadTicketView({ params, searchParams }: Props) {

  const { token } = await params;
  const safeToken = validToken(token);
  if (!safeToken) notFound();
  const returningFromCheckout = (await searchParams)?.payment === "return";

  // Back from the provider's page: one status read so the ticket can confirm
  // before the webhook arrives (rate limited; the webhook stays the authority).
  if (returningFromCheckout) {
    const pending = await prisma.rSVP.findUnique({
      where: { checkInToken: safeToken },
      select: { status: true, orderId: true },
    });
    if (pending?.status === "PENDING_PAYMENT" && pending.orderId) await refreshOrderFromProvider(pending.orderId).catch(() => undefined);
  }

  const rsvp = await prisma.rSVP.findUnique({
    where: { checkInToken: safeToken },
    include: {
      user: { select: { name: true } },
      ticketType: { select: { name: true } },
      order: {
        select: {
          currency: true, testMode: true, totalMinor: true,
          lines: { select: { ticketTypeId: true, unitMinor: true } },
          payments: {
            where: { status: { in: [PaymentStatus.PENDING, PaymentStatus.PAID_ONLINE, PaymentStatus.PAID_OFFLINE, PaymentStatus.WAIVED] } },
            select: { status: true },
            orderBy: { createdAt: "desc" },
            take: 1,
          },
        },
      },
      event: {
        select: {
          title: true,
          startDateTime: true,
          endDateTime: true,
          timezone: true,
          location: true,
          mapLinkUrl: true,
          isOnline: true,
          slug: true,
          organisationId: true,
          registrationMode: true,
          soloPolicy: true,
          status: true,
          submissionsEnabled: true,
          page: { select: { accentColor: true, isPublished: true } },
          organisation: { select: { slug: true, name: true } },
        },
      },
      eventInstance: {
        select: {
          startDateTime: true,
          endDateTime: true,
          series: {
            select: {
              title: true,
              timezone: true,
              organisation: { select: { slug: true, name: true } },
            },
          },
        },
      },
    },
  });

  if (!rsvp) notFound();

  let orgName: string;
  let orgSlug: string;
  let eventSlug: string | null = null;
  let title: string;
  let start: Date;
  let timeZone: string;
  let location: string | null = null;
  let mapHref: string | null = null;
  let accent: string | null | undefined;
  let calendarEvent: CalendarEvent;

  if (rsvp.eventId && rsvp.event) {
    const ev = rsvp.event;
    orgName = ev.organisation.name;
    orgSlug = ev.organisation.slug;
    eventSlug = ev.slug;
    title = ev.title;
    start = ev.startDateTime;
    timeZone = safeTimeZone(ev.timezone);
    location = ev.location || null;
    mapHref = ev.isOnline ? null : safeHttpUrl(ev.mapLinkUrl);
    accent = ev.page?.accentColor;
    calendarEvent = {
      title: ev.title,
      startDateTime: ev.startDateTime,
      endDateTime: ev.endDateTime,
      timezone: ev.timezone,
      location: ev.location,
    };
  } else if (rsvp.eventInstanceId && rsvp.eventInstance) {
    const inst = rsvp.eventInstance;
    orgName = inst.series.organisation.name;
    orgSlug = inst.series.organisation.slug;
    title = inst.series.title;
    start = inst.startDateTime;
    timeZone = safeTimeZone(inst.series.timezone);
    accent = INK_ACCENT;
    calendarEvent = {
      title: inst.series.title,
      startDateTime: inst.startDateTime,
      endDateTime: inst.endDateTime,
      timezone: inst.series.timezone,
    };
  } else {
    notFound();
  }

  const status = statusLabel(rsvp.status);
  const isCheckedIn = Boolean(rsvp.checkedInAt);

  const confirmed = rsvp.status === "CONFIRMED";
  const name = displayName(rsvp);
  const eventPageHref = eventSlug ? `/${orgSlug}/${eventSlug}` : rsvp.eventInstanceId ? `/${orgSlug}/i/${rsvp.eventInstanceId}` : `/${orgSlug}`;
  // A pass seats its holder on every date: this ticket links to the others,
  // which belong to the same person in the same order.
  const otherDates = rsvp.orderId && rsvp.eventInstanceId
    ? (await prisma.rSVP.findMany({
      where: { orderId: rsvp.orderId, attendeeKey: rsvp.attendeeKey, id: { not: rsvp.id }, eventInstanceId: { not: null } },
      select: { checkInToken: true, status: true, eventInstance: { select: { startDateTime: true, cancelledAt: true } } },
      orderBy: { eventInstance: { startDateTime: "asc" } },
    })).map((other) => ({ href: `/ticket/${other.checkInToken}`, start: other.eventInstance!.startDateTime, cancelled: Boolean(other.eventInstance!.cancelledAt) }))
    : [];


  // Amounts and hold times only; provider ids and links stay on the server.
  // This ticket's own price from its order line; the order's other tickets stay private.
  const order = rsvp.order;
  const payment = order?.payments[0];
  const unit = order?.lines.find((line) => line.ticketTypeId === rsvp.ticketTypeId)?.unitMinor;
  const paymentView = order && order.totalMinor > BigInt(0) && unit != null ? {
    status: payment?.status ?? null,
    ticketName: rsvp.ticketType?.name ?? null,
    amount: formatMoney(unit, order.currency),
    testMode: order.testMode,
    paid: payment?.status === PaymentStatus.PAID_ONLINE || payment?.status === PaymentStatus.PAID_OFFLINE,
  } : null;
  const hold = rsvp.status === "PENDING_PAYMENT"
    ? { active: isActiveHold(rsvp), expiresAt: rsvp.holdExpiresAt?.toISOString() ?? null, canPay: isActiveHold(rsvp) && payment?.status === PaymentStatus.PENDING }
    : null;

  // Crew tickets (docs/CREW.md) are free and issued by the organisers: no
  // team, project, cancel, payment or transfer controls (the servers refuse them too).
  const isCrew = rsvp.isCrew;
  const viewerId = isCrew ? null : await ticketViewerId(rsvp);
  const teamSection = isCrew ? null : await loadTicketTeamSection(rsvp, isCheckedIn, viewerId);
  const submissionMode = isCrew ? null : ticketSubmissionMode(rsvp, viewerId);
  const claims = await loadTicketClaims(rsvp);
  // Applications (docs/ADMISSION.md): where this registration's application stands, and the offer.
  const application = await loadTicketApplication(rsvp);
  // A designed ticket (docs/TICKET_DESIGNER.md) is shown above the live check-in stub.
  const designedTicket = rsvp.status === "CONFIRMED" ? Boolean((await ticketDesignFor(rsvp.checkInToken))?.custom) : false;
  return { isCrew, designedTicket, claims, application, teamSection, submissionMode, inTeam: Boolean(rsvp.teamId), rsvp: { checkInToken: rsvp.checkInToken, checkedInAt: rsvp.checkedInAt, status: rsvp.status }, orgName, orgSlug, eventSlug, title, start, timeZone, location, mapHref, accent, calendarEvent, status, isCheckedIn, confirmed, name, eventPageHref, safeToken, payment: paymentView, hold, returningFromCheckout, otherDates };
}
