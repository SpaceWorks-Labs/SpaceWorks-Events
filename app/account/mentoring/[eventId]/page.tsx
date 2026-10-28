import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { loadAccountMentoringView } from "@/lib/views/app__account__mentoring__eventId__page";
import { GetHelpCard } from "@/components/mentor-desk/participant/GetHelpCard";
import { MentorsCard } from "@/components/mentor-desk/participant/MentorsCard";

type Props = {
  params: Promise<{ eventId: string }>;
};

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Get help",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

/**
 * A signed-in participant's Mentor Desk page (docs/MENTOR_DESK.md), linked
 * from their ticket: ask for help, follow requests, and (for teams) book
 * office hours. It resolves only while this account owns a CONFIRMED
 * registration on an event with the desk on; anything else is a plain 404.
 */
export default async function AccountMentoringPage({ params }: Props) {
  const { view, title, deskRef } = await loadAccountMentoringView({ params });
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Link href="/account/registrations" className="inline-flex min-h-10 items-center gap-1.5 self-start text-[15px] font-semibold text-ink-secondary hover:text-ink">
        <ArrowLeft aria-hidden className="size-4" />
        Registrations
      </Link>
      <h1 className="text-h2 text-ink">{title}</h1>
      <GetHelpCard deskRef={deskRef} view={view} />
      <MentorsCard deskRef={deskRef} view={view} />
    </div>
  );
}
