import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, Check, Download } from "lucide-react";
import { AttendeeDetailsForm, CancelOrderButton, ConfirmingPayment, HoldCountdown, PayNowButton, TransferTicketForm } from "@/components/orders/OrderClient";
import { Button } from "@/components/ui/button";
import { Callout, Chip } from "@/components/ui/display";
import { formatDayShort, formatTime } from "@/lib/format/datetime";
import { loadOrderView, loadRouteMetadata } from "@/lib/views/app__order__token__page";
import { RefundRequestForm } from "@/components/orders/RefundRequestForm";

type Props = {
  params: Promise<{ token: string; }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> { return loadRouteMetadata(); }

const STATUS: Record<string, { label: string; tone: "success" | "warning" | "neutral"; }> = {
  REQUESTED: { label: "Requested", tone: "neutral" },
  PENDING: { label: "Awaiting payment", tone: "warning" },
  CONFIRMED: { label: "Confirmed", tone: "success" },
  EXPIRED: { label: "Released", tone: "neutral" },
  CANCELLED: { label: "Cancelled", tone: "neutral" },
};

export default async function OrderPage({ params, searchParams }: Props) {
  const order = await loadOrderView({ params, searchParams });
  const status = STATUS[order.status] ?? STATUS.PENDING!;
  return (
    <div className="mx-auto flex w-full max-w-[560px] flex-col gap-5 py-2 sm:py-6">
      {order.event?.href ? (
        <Link href={order.event.href} className="inline-flex min-h-10 items-center gap-1.5 text-[15px] font-semibold text-ink-secondary hover:text-ink">
          <ArrowLeft aria-hidden className="size-4" />
          Event page
        </Link>
      ) : null}
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Chip tone={status.tone} icon={order.status === "CONFIRMED" ? <Check /> : undefined}>{status.label}</Chip>
          {order.testMode ? <Chip tone="warning">Test mode</Chip> : null}
        </div>
        <h1 className="text-display-m break-words text-ink">{order.event?.title ?? "Your order"}</h1>
        <p className="text-body-ui text-ink-muted">
          Order {order.reference}
          {order.event?.start ? ` · ${formatDayShort(new Date(order.event.start), order.event.timeZone)} ${formatTime(new Date(order.event.start), order.event.timeZone)}` : ""}
          {order.event ? ` · ${order.event.organisation}` : ""}
        </p>
      </header>

      {order.status === "PENDING" && order.holdActive ? (
        <section className="flex flex-col gap-3">
          {order.returning ? <ConfirmingPayment /> : null}
          {order.holdExpiresAt ? <HoldCountdown expiresAt={order.holdExpiresAt} /> : null}
          {order.canPay ? <PayNowButton endpoint={`/api/orders/${order.token}/checkout`} /> : null}
        </section>
      ) : null}
      {order.status === "EXPIRED" || (order.status === "PENDING" && !order.holdActive) ? (
        <Callout tone="warning">
          The time to pay ran out, so these tickets went back on sale and nothing was charged.{" "}
          {order.event?.href ? <Link href={order.event.href} className="font-semibold underline underline-offset-4">Order again</Link> : null}
        </Callout>
      ) : null}

      {order.status === "REQUESTED" ? (
        <Callout tone="info">
          Nothing has been charged.{" "}
          {order.tickets.some((ticket) => ticket.status === "WAITLISTED")
            ? "You're on the waitlist: if places free up, we'll email you a link to pay."
            : "If the organiser approves your request, we'll email you a link to pay."}
        </Callout>
      ) : null}
      {order.status === "CANCELLED" ? (
        <Callout tone="info">
          This order was cancelled.{order.refunded ? ` ${order.refunded.amount} ${order.refunded.pending ? "is being refunded" : "was refunded"}; card and UPI refunds can take 5 to 10 working days to appear.` : ""}
        </Callout>
      ) : order.refunded ? (
        <Callout tone="info">{order.refunded.amount} {order.refunded.pending ? "is being refunded" : "has been refunded"} on this order.</Callout>
      ) : null}

      <section aria-labelledby="order-lines" className="rounded-xl border border-line bg-panel p-5">
        <h2 id="order-lines" className="sr-only">Order summary</h2>
        <dl className="flex flex-col gap-2">
          {order.lines.map((line) => (
            <div key={line.id} className="flex justify-between gap-3 text-body-ui">
              <dt className="text-ink-secondary">{line.label}</dt>
              <dd className="tabular-nums text-ink">{line.amount}</dd>
            </div>
          ))}
          {order.discount ? (
            <div className="flex justify-between gap-3 text-body-ui">
              <dt className="text-ink-secondary">Discount</dt>
              <dd className="tabular-nums text-ink">−{order.discount}</dd>
            </div>
          ) : null}
          <div className="mt-1 flex justify-between gap-3 border-t border-line pt-3 font-semibold">
            <dt className="text-ink">Total</dt>
            <dd className="tabular-nums text-ink">{order.free ? "Free" : order.total}</dd>
          </div>
          {!order.free && order.event ? (
            <div className="flex justify-between gap-3 text-body-ui">
              <dt className="text-ink-secondary">Paid to</dt>
              <dd className="text-right text-ink">{order.event.organisation}</dd>
            </div>
          ) : null}
        </dl>
        {order.refundPolicy ? <p className="mt-3 text-caption text-ink-muted">{order.refundPolicy}</p> : null}
        {order.receiptHref ? (
          <div className="mt-4">
            <Button asChild size="sm" variant="secondary">
              <a href={order.receiptHref} download>
                <Download aria-hidden className="size-4" />
                Download receipt (PDF)
              </a>
            </Button>
          </div>
        ) : null}
      </section>

      <section aria-labelledby="order-tickets" className="flex flex-col gap-3">
        <h2 id="order-tickets" className="text-h4 text-ink">{order.pass ? "Passes" : "Tickets"}</h2>
        {order.pass ? <p className="text-body-ui text-ink-secondary">Each pass is a ticket for every remaining date. Its ticket page lists them all.</p> : null}
        {order.tickets.some((ticket) => ticket.needsDetails) ? (
          <Callout tone="info">Add each attendee&apos;s name and email so they get their own ticket.</Callout>
        ) : null}
        <ul className="flex flex-col gap-3">
          {order.tickets.map((ticket) => (
            <li key={ticket.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-panel p-4">
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-ink">{ticket.label}</p>
                <p className="truncate text-caption text-ink-muted">{ticket.email ? `${ticket.name} · ${ticket.email}` : "No attendee yet"}</p>
              </div>
              {ticket.ticketHref ? (
                <Button asChild size="sm" variant="secondary"><Link href={ticket.ticketHref}>View ticket</Link></Button>
              ) : null}
              {!ticket.checkedIn ? <AttendeeDetailsForm orderToken={order.token} ticket={ticket} fields={order.fields} /> : null}
              {ticket.transferUntil ? <TransferTicketForm orderToken={order.token} rsvpId={ticket.id} label={ticket.label} until={ticket.transferUntil} /> : null}
            </li>
          ))}
        </ul>
      </section>

      {order.cancellation ? (
        <section aria-labelledby="order-cancel" className="flex flex-col gap-2 border-t border-line pt-5">
          <h2 id="order-cancel" className="text-h4 text-ink">Can&apos;t make it?</h2>
          <p className="text-body-ui text-ink-secondary">
            Cancelling gives up every ticket in this order{order.cancellation.refund ? ` and refunds ${order.cancellation.refund}` : ""}.{order.cancellation.team ? ` This is the team ticket for ${order.cancellation.team}, so everyone in the team loses their place too.` : ""}
          </p>
          <div><CancelOrderButton orderToken={order.token} refund={order.cancellation.refund} /></div>
        </section>
      ) : null}

      {order.refundRequest || order.canRequestRefund ? (
        <section aria-labelledby="order-refund-request" className="flex flex-col gap-2 border-t border-line pt-5">
          <h2 id="order-refund-request" className="text-h4 text-ink">Need a refund?</h2>
          {order.refundRequest?.status === "OPEN" ? <Callout tone="info">You asked for a refund. The organisers will reply by email.</Callout> : null}
          {order.refundRequest?.status === "DECLINED" ? <Callout tone="warning" title="Your last request wasn&apos;t approved">{order.refundRequest.note}</Callout> : null}
          {order.refundRequest?.status === "APPROVED" ? <Callout tone="success">Your refund request was approved{order.refundRequest.approved ? `: ${order.refundRequest.approved}` : ""}.</Callout> : null}
          {order.canRequestRefund ? (
            <>
              <p className="text-body-ui text-ink-secondary">{order.cancellation ? "Want more back than the policy gives, or to keep your tickets?" : "Outside the refund policy, you can still ask the organisers."}</p>
              <RefundRequestForm orderToken={order.token} />
            </>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
