import Link from "next/link";
import { LifeBuoy } from "lucide-react";
import { buttonClasses } from "@/components/ui/button";

/**
 * The ticket page's Mentor Desk card (docs/MENTOR_DESK.md). Help is asked
 * from the signed-in account (or the team page), never from the ticket link
 * alone, so this only points there.
 */
export function TicketMentorDeskCard({ desk }: { desk: { href: string; signedIn: boolean; hasAccount: boolean } }) {
  const signInHref = `/login?callbackUrl=${encodeURIComponent(desk.href)}`;
  return (
    <section aria-labelledby="ticket-mentors" className="flex flex-col gap-3 rounded-xl border border-line bg-panel p-4">
      <h2 id="ticket-mentors" className="flex items-center gap-2 text-h4 text-ink"><LifeBuoy aria-hidden className="size-5" />Mentors</h2>
      <p className="text-body-ui text-ink-secondary">
        {desk.hasAccount
          ? "Ask a mentor for help, follow your requests and book office hours."
          : "Mentors can help during the event. Your team leader can ask from the team page, or sign up with this email to ask yourself."}
      </p>
      {desk.hasAccount ? (
        <Link href={desk.signedIn ? desk.href : signInHref} className={buttonClasses({ variant: "secondary", className: "self-start" })}>
          {desk.signedIn ? "Get help" : "Sign in to get help"}
        </Link>
      ) : null}
    </section>
  );
}
