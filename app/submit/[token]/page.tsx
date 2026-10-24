import type { Metadata } from "next";
import { loadSubmitView } from "@/lib/views/app__submit__token__page";
import { accentStyle } from "@/lib/theme/accent";
import { SubmissionSection } from "@/components/submission/SubmissionSection";

type Props = {
  params: Promise<{ token: string }>;
};

// The submission link is a bearer capability (docs/HACKATHON.md): render per
// request, never cache (dynamic pages are sent `private, no-store`), never
// index, and never leak the address through Referer.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Your project",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

/**
 * A solo registrant's project page, reached from the link emailed on request
 * from their ticket page. A malformed, retired, or foreign token, or an event
 * that does not take submissions, is a plain 404.
 */
export default async function SubmitPage({ params }: Props) {
  const { view, submissionToken, accentColor } = await loadSubmitView({ params });
  return (
    <div style={accentStyle(accentColor)} className="yy-accent-scope mx-auto flex w-full max-w-[640px] flex-col py-2 sm:py-6">
      <SubmissionSection view={view} submissionRef={{ submissionToken }} variant="page" />
    </div>
  );
}
