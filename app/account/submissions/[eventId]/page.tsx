import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { loadAccountSubmissionView } from "@/lib/views/app__account__submissions__eventId__page";
import { SubmissionSection } from "@/components/submission/SubmissionSection";

type Props = {
  params: Promise<{ eventId: string }>;
};

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Your project",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

/**
 * A signed-in entrant's project page, linked from Account → Registrations:
 * any member of a team (the team's shared submission) or the owner of a solo
 * registration. The event id alone grants nothing: it resolves only while
 * this account owns a registration on the event, and anything else is a
 * plain 404.
 */
export default async function AccountSubmissionPage({ params }: Props) {
  // The reader authenticates; the account layout is not an authorization boundary.
  const { view, eventId } = await loadAccountSubmissionView({ params });
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Link href="/account/registrations" className="inline-flex min-h-10 items-center gap-1.5 self-start text-[15px] font-semibold text-ink-secondary hover:text-ink">
        <ArrowLeft aria-hidden className="size-4" />
        Registrations
      </Link>
      <div className="rounded-2xl border border-line bg-canvas p-5 sm:p-6"><SubmissionSection view={view} submissionRef={{ eventId }} variant="page" /></div>
    </div>
  );
}
