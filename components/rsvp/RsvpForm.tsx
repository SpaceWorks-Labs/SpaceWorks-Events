"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useAuthSession } from "@/components/auth/useAuthSession";
import { useRouter } from "next/navigation";
import type { RsvpStatus } from "@prisma/client";
import type { RegistrationFieldDefinition } from "@/components/rsvp/registrationTypes";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/display";
import { RegistrationQuestions, focusQuestion, useRegistrationAnswers } from "@/components/rsvp/QuestionField";
import { identityErrors } from "@/components/rsvp/registrationAnswers";
import { TeamRegistrationFields, useTeamRegistration, type TeamRegistrationConfig } from "@/components/rsvp/TeamRegistrationFields";
import { AddOnPicker, TicketPicker, ticketAvailable } from "@/components/rsvp/TicketPicker";
import { AccessCodeField, PromoCodeField, previewOrderTotal, type AppliedPromo, type TicketingInfo } from "@/components/rsvp/PromoCodeField";
import { formatMoney } from "@/lib/payments/money";
import type { PublicAddOn, PublicTicketType } from "@/lib/payments/tickets";
import { Radio, RadioGroup } from "@/components/ui/choice";
import { AttendeeFields } from "./RsvpForm/AttendeeFields";
import { postRsvp, safeJsonParse, storageKey } from "./RsvpForm/helpers";
import { FramedCheckoutNotice, RsvpDone } from "./RsvpForm/states";
import { GuestIdentityFields, SignedInNameField } from "./RsvpForm/IdentityFields";

export function RsvpForm(props: {
  orgSlug: string;
  eventSlug?: string;
  eventInstanceId?: string;
  registrationFields?: RegistrationFieldDefinition[];
  /** Team event settings (docs/TEAMS.md); omit for individual registration. */
  team?: TeamRegistrationConfig | null;
  /** Ticket types to buy; registration without tickets when empty. */
  tickets?: PublicTicketType[];
  /** Extras to buy alongside tickets. */
  addOns?: PublicAddOn[];
  paidSalesOpen?: boolean;
  /** Paid tickets: whether promo codes exist, and the refund terms. */
  ticketing?: TicketingInfo | null;
  /** A paid order is only a request first: it needs approval, or waits for a place. */
  paidRequest?: "approval" | "waitlist" | null;
  /** Lets a containing event page update immediately after this tab saves an RSVP. */
  onRsvpSaved?: (rsvp: { ticketToken: string; status: RsvpStatus | null; teamMode: "create" | "join" | "solo" | null }) => void;
}) {
  const { orgSlug, eventSlug, eventInstanceId, registrationFields, team, onRsvpSaved, tickets: listed = [], paidSalesOpen = false, ticketing = null, paidRequest = null } = props;
  const addOns = useMemo(() => props.addOns ?? ticketing?.addOns ?? [], [props.addOns, ticketing]);
  // Tickets an access code revealed join the public ones.
  const [unlocked, setUnlocked] = useState<PublicTicketType[]>([]);
  const [accessCode, setAccessCode] = useState<string | null>(null);
  const tickets = useMemo(() => [...listed, ...unlocked.filter((ticket) => !listed.some((other) => other.id === ticket.id))], [listed, unlocked]);
  const sellsTicketTypes = tickets.length > 0 || Boolean(ticketing?.accessCodes);
  const [amounts, setAmounts] = useState<Record<string, number>>({});
  const [addOnQuantities, setAddOnQuantities] = useState<Record<string, number>>({});
  const [payAtDesk, setPayAtDesk] = useState(false);
  const [quantities, setQuantities] = useState<Record<string, number>>(() => {
    // Start with one of the first ticket that can be bought.
    const first = tickets.find((ticket) => ticketAvailable(ticket, paidSalesOpen));
    return first ? { [first.id]: first.minPerOrder } : {};
  });
  const [ticketError, setTicketError] = useState<string | undefined>();
  // Inside the embed widget's frame, provider pages must open in a new top-level tab.
  const [framedCheckout, setFramedCheckout] = useState<{ checkoutUrl: string; orderToken: string | null } | null>(null);
  const [attendees, setAttendees] = useState<Array<{ name: string; email: string }>>([]);
  // People, not tickets: a group ticket seats several.
  const seats = Object.entries(quantities).reduce((sum, [id, quantity]) => sum + quantity * (tickets.find((ticket) => ticket.id === id)?.seatsPerTicket ?? 1), 0);
  const [promo, setPromo] = useState<AppliedPromo | null>(null);
  const { totalMinor, discountMinor, feeMinor, promoProblem, priceProblem } = previewOrderTotal(tickets, quantities, promo, { amounts, addOns: addOnQuantities, addOnTypes: addOns });
  // Paying at the desk is offered when every chosen ticket allows it.
  const chosen = tickets.filter((ticket) => (quantities[ticket.id] ?? 0) > 0);
  const deskOffered = totalMinor > 0 && !paidRequest && chosen.length > 0 && chosen.every((ticket) => ticket.payAtDesk);
  const atDesk = deskOffered && payAtDesk;
  const currency = tickets[0]?.currency ?? addOns[0]?.currency ?? "INR";
  const sellsPaid = tickets.some((ticket) => ticket.priceMinor > 0 || ticket.flexible || ticket.feeMinor > 0) || addOns.some((addOn) => addOn.priceMinor > 0);
  const { data: session, status } = useAuthSession();
  const router = useRouter();
  const lsKey = storageKey({ orgSlug, eventSlug, eventInstanceId });
  const [guestEmail, setGuestEmail] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [rsvpStatus, setRsvpStatus] = useState<RsvpStatus | null>(null);
  const [ticketToken, setTicketToken] = useState("");
  const [registeredAs, setRegisteredAs] = useState<"create" | "join" | "solo" | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const saved = safeJsonParse<{ ticketToken?: string }>(
        window.localStorage.getItem(lsKey),
      );
      setTicketToken(saved?.ticketToken ?? "");
    }, 0);
    return () => window.clearTimeout(timer);
  }, [lsKey]);
  const [pending, startTransition] = useTransition();

  const fields = useMemo(() => registrationFields ?? [], [registrationFields]);
  const questionsState = useRegistrationAnswers(fields);
  const teamState = useTeamRegistration(team);
  const [identity, setIdentity] = useState<{ name?: string; email?: string }>({});
  const formRef = useRef<HTMLDivElement & HTMLFormElement>(null);
  const requireName = !session?.user?.name?.trim();
  const isGuest = !session?.user;
  const problemCount = Object.keys(questionsState.errors).length + Object.values(identity).filter(Boolean).length + teamState.problemCount();

  /** Client-side checks first, so each question shows its own message; the server still decides. */
  function checkBeforeSubmit() {
    const firstTeamProblem = teamState.validate();
    const who = identityErrors({ name, email: guestEmail, requireName: isGuest || requireName, requireEmail: isGuest });
    const questionErrors = questionsState.validate();
    setIdentity(who);
    const missingTicket = sellsTicketTypes && seats === 0;
    const ticketProblem = missingTicket ? "Choose at least one ticket." : priceProblem ?? undefined;
    setTicketError(ticketProblem);
    const firstQuestion = fields.find((field) => questionErrors[field.key])?.key;
    const first = ticketProblem ? "__ticket" : firstTeamProblem ?? (who.name ? "__name" : who.email ? "__email" : firstQuestion);
    if (first) focusQuestion(formRef.current, first);
    return !first;
  }

  function submit() {
    setError(null);
    if (teamState.awaitingLink) return;
    if (!checkBeforeSubmit()) return;
    const teamIntent = teamState.payload();
    startTransition(async () => {
      const res = await postRsvp({
        orgSlug,
        ...(eventInstanceId ? { eventInstanceId } : { eventSlug: eventSlug! }),
        ...(isGuest ? { guestEmail } : {}),
        ...(sellsTicketTypes ? {
          items: Object.entries(quantities).filter(([, quantity]) => quantity > 0).map(([ticketTypeId, quantity]) => ({
            ticketTypeId, quantity,
            ...(tickets.find((ticket) => ticket.id === ticketTypeId)?.flexible && amounts[ticketTypeId] != null ? { amountMinor: amounts[ticketTypeId] } : {}),
          })),
          attendees: attendees.slice(0, Math.min(19, Math.max(0, seats - 1))).map((attendee) => ({ name: attendee.name.trim() || undefined, email: attendee.email.trim() })),
          ...(promo ? { promoCode: promo.code } : {}),
          ...(accessCode ? { accessCode } : {}),
          ...(atDesk ? { payAtDesk: true } : {}),
          ...(Object.values(addOnQuantities).some((quantity) => quantity > 0) ? { addOns: Object.entries(addOnQuantities).filter(([, quantity]) => quantity > 0).map(([addOnId, quantity]) => ({ addOnId, quantity })) } : {}),
        } : {}),
        name,
        answers: questionsState.payload(),
        ...(teamIntent ? { team: teamIntent } : {}),
      });
      if (!res.ok) setError(res.error);
      else {
        setRegisteredAs(teamIntent?.mode ?? null);
        saveSuccessfulRsvp({ ticketToken: res.ticketToken, status: res.status }, res, teamIntent?.mode ?? null);
      }
    });
  }

  function saveSuccessfulRsvp(rsvp: { ticketToken: string; status: RsvpStatus | null }, order: { orderToken?: string | null; checkoutUrl?: string | null } = {}, teamMode: "create" | "join" | "solo" | null = null) {
    setTicketToken(rsvp.ticketToken);
    setRsvpStatus(rsvp.status);
    if (rsvp.ticketToken) {
      try {
        window.localStorage.setItem(
          lsKey,
          JSON.stringify({
            ticketToken: rsvp.ticketToken,
            status: rsvp.status,
            registeredAt: new Date().toISOString(),
          }),
        );
      } catch {
        // The confirmed server state remains usable in this open page even if
        // this browser has disabled local storage.
      }
    }
    // A paid order continues on the provider's hosted page, or on the order
    // page ("Pay now") if that page couldn't open yet. Orders for several
    // people go to the order page to name each attendee.
    if (rsvp.status === "PENDING_PAYMENT" && order.checkoutUrl) {
      if (window.self !== window.top) setFramedCheckout({ checkoutUrl: order.checkoutUrl, orderToken: order.orderToken ?? null });
      else window.location.assign(order.checkoutUrl);
      return;
    }
    if (order.orderToken && (rsvp.status === "PENDING_PAYMENT" || seats > 1)) {
      router.push(`/order/${order.orderToken}`);
      return;
    }
    onRsvpSaved?.({ ...rsvp, teamMode });
    setDone(true);
    // Re-read the going count and spots left, which now include this registration.
    router.refresh();
  }

  if (status === "loading") {
    return <p className="text-body-ui text-ink-muted">Loading…</p>;
  }

  if (framedCheckout) {
    return <FramedCheckoutNotice framedCheckout={framedCheckout} />;
  }

  if (done) {
    return <RsvpDone ticketToken={ticketToken} rsvpStatus={rsvpStatus} sellsPaid={sellsPaid} registeredAs={registeredAs} joinTeamName={team?.joinTeam?.name ?? null} />;
  }

  const questions = <RegistrationQuestions controller={questionsState} />;
  const teamFields = <TeamRegistrationFields controller={teamState} />;
  const ticketSection = sellsTicketTypes ? (
    <div data-question-key="__ticket" className="flex flex-col gap-3">
      {tickets.length > 0 ? (
        <TicketPicker
          tickets={tickets}
          quantities={quantities}
          onChange={(next) => { setQuantities(next); setTicketError(undefined); }}
          error={ticketError}
          paidSalesOpen={paidSalesOpen}
          amounts={amounts}
          onAmountChange={(id, amount) => { setAmounts((current) => { const next = { ...current }; if (amount == null) delete next[id]; else next[id] = amount; return next; }); setTicketError(undefined); }}
        />
      ) : ticketError ? <p role="alert" className="text-caption text-danger-fg">{ticketError}</p> : null}
      {ticketing?.accessCodes ? (
        <AccessCodeField orgSlug={orgSlug} eventSlug={eventSlug} eventInstanceId={eventInstanceId} applied={accessCode} onUnlocked={(code, revealed) => { setAccessCode(code); setUnlocked(revealed); setTicketError(undefined); }} />
      ) : null}
      <AddOnPicker addOns={addOns} quantities={addOnQuantities} onChange={setAddOnQuantities} />
      {seats > 1 ? (
        <AttendeeFields seats={seats} attendees={attendees} setAttendees={setAttendees} />
      ) : null}
      {ticketing?.promoCodes && (eventSlug || eventInstanceId) ? (
        <PromoCodeField orgSlug={orgSlug} eventSlug={eventSlug} eventInstanceId={eventInstanceId} applied={promo} onApplied={setPromo} problem={promoProblem} />
      ) : null}
      {discountMinor > 0 ? (
        <p className="text-body-ui text-ink">Discount: −{formatMoney(discountMinor, currency)} · Total {formatMoney(totalMinor, currency)}</p>
      ) : null}
      {feeMinor > 0 ? <p className="text-caption text-ink-muted">Includes {formatMoney(feeMinor, currency)} in booking fees.</p> : null}
      {deskOffered ? (
        <RadioGroup value={payAtDesk ? "desk" : "online"} onValueChange={(value) => setPayAtDesk(value === "desk")} aria-label="How you'll pay">
          <Radio value="online" label="Pay online now" />
          <Radio value="desk" label="Pay at the desk" description="Your places are reserved now; pay when you arrive." />
        </RadioGroup>
      ) : null}
      {sellsPaid && ticketing ? (
        <p className="text-caption text-ink-muted">
          {ticketing.refundPolicy}{ticketing.refundPolicyText ? ` ${ticketing.refundPolicyText}` : ""}
        </p>
      ) : null}
    </div>
  ) : null;
  const submitLabel = totalMinor <= 0
    ? "Register"
    : atDesk
      ? `Reserve, pay ${formatMoney(totalMinor, currency)} at the desk`
    : paidRequest === "approval"
      ? `Request tickets · ${formatMoney(totalMinor, currency)}`
      : paidRequest === "waitlist"
        ? "Join the waitlist"
        : `Continue to payment · ${formatMoney(totalMinor, currency)}`;
  const problems = problemCount > 0 ? (
    <Callout tone="danger" role="alert">
      {problemCount === 1 ? "One answer needs a quick fix before you can register." : `${problemCount} answers need a quick fix before you can register.`}
    </Callout>
  ) : null;

  // "Join with a link" without a link: only the explanation, nothing to
  // submit. The team choice stays in the same element either way, so moving
  // between the options with the arrow keys never remounts the radio group
  // (which would drop keyboard focus out of it).
  const awaitingLink = teamState.awaitingLink;

  if (session?.user) {
    return (
      <div ref={formRef} className="flex flex-col gap-3.5">
        {error ? <Callout tone="danger" role="alert">{error}</Callout> : null}
        {problems}
        {teamFields}
        {ticketSection}
        {awaitingLink ? null : (
          <>
            <SignedInNameField name={name} setName={setName} identity={identity} setIdentity={setIdentity} requireName={requireName} accountName={session.user.name} />
            {questions}
            <Button variant="accent" size="lg" fullWidth loading={pending} loadingLabel="Registering…" onClick={submit}>
              {submitLabel}
            </Button>
          </>
        )}
      </div>
    );
  }

  return (
    <form
      ref={formRef}
      noValidate
      className="flex flex-col gap-3.5"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {error ? <Callout tone="danger" role="alert">{error}</Callout> : null}
      {problems}
      {teamFields}
      {ticketSection}
      {awaitingLink ? null : (
        <>
          <p className="text-body-ui text-ink-muted">Your details</p>
          <GuestIdentityFields name={name} setName={setName} guestEmail={guestEmail} setGuestEmail={setGuestEmail} identity={identity} setIdentity={setIdentity} />
          {questions}
          <Button variant="accent" size="lg" fullWidth type="submit" loading={pending} loadingLabel="Registering…">
            {submitLabel}
          </Button>
        </>
      )}
    </form>
  );
}
