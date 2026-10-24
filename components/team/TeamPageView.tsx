import type { ReactNode } from "react";
import { SoloPolicy } from "@prisma/client";
import { formatDayShort, formatTime, formatTimeZoneName } from "@/lib/format/datetime";
import { safeTimeZone } from "@/lib/timeZone";
import { accentStyle } from "@/lib/theme/accent";
import type { TeamPageData } from "@/lib/teamPageData";
import type { TeamRef } from "@/app/actions/teams";
import { TeamManager } from "./TeamManager";

/**
 * Shared body of the leader's team page, reached by management token
 * (`/team/{token}`) or by a signed-in leader (`/account/teams/{teamId}`).
 * Its data comes from the page's guarded view reader.
 */
export function TeamPageView({ data, teamRef, tokenPage, submission = null }: {
  data: TeamPageData;
  teamRef: TeamRef;
  tokenPage: boolean;
  /** The team's submission section (components/submission), when the event takes submissions. */
  submission?: ReactNode;
}) {
  const { page, seekers, accentColor } = data;
  const timeZone = safeTimeZone(page.event.timezone);
  const start = page.event.startDateTime;
  const whenLabel = `${formatDayShort(start, timeZone)} · ${formatTime(start, timeZone)} ${formatTimeZoneName(start, timeZone)}`;

  return (
    <div style={accentStyle(accentColor)} className="yy-accent-scope mx-auto flex w-full max-w-[640px] flex-col py-2 sm:py-6">
      <TeamManager
        teamRef={teamRef}
        tokenPage={tokenPage}
        baseUrl={(process.env.NEXT_PUBLIC_BASE_URL ?? "").replace(/\/+$/, "")}
        team={page.team}
        event={{
          title: page.event.title,
          href: `/${page.event.orgSlug}/${page.event.eventSlug}`,
          whenLabel,
          registrationOpen: page.event.registrationOpen,
          matching: page.event.soloPolicy === SoloPolicy.SOLO_WITH_MATCHING,
          inviteOnly: page.event.inviteOnly,
        }}
        members={page.members}
        pendingRequests={page.pendingRequests}
        seekers={seekers}
        submissionSlot={submission}
      />
    </div>
  );
}
