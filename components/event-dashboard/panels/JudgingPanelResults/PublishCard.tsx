"use client";

import { useState } from "react";
import { ExternalLink } from "lucide-react";
import type { JudgingStatus } from "@prisma/client";
import { publishJudgingResults, sendResultsAnnouncement, unpublishJudgingResults } from "@/app/actions/judging-admin";
import { ConfirmationDialog } from "@/components/feedback/ConfirmationDialog";
import { Button } from "@/components/ui/button";
import { Callout, Card, CardHeader, Chip } from "@/components/ui/display";
import { formatDayTime } from "@/lib/format/datetime";
import {
  announcedBefore,
  publishedResultsEmailLine,
  publishResultsEmailCopy,
  resultsAnnouncementState,
  sendResultsEmailCopy,
  unpublishedResultsEmailLine,
} from "@/lib/hackathonEmails";
import { resultsPublishHint } from "../judgingCopy";
import { useJudgingAction, type JudgingScope } from "../JudgingPanelShared";

export function PublishCard({
  scope,
  judgingStatus,
  resultsPublishedAt,
  resultsAnnouncedAt,
  emailEntrantsOnResults,
  announcementRecipients,
  resultsUrl,
  timezone,
}: {
  scope: JudgingScope;
  judgingStatus: JudgingStatus;
  resultsPublishedAt: string | null;
  /** Set once entrants were emailed the results. */
  resultsAnnouncedAt: string | null;
  /** "Email entrants when results are published" (Judging → Setup), off by default. */
  emailEntrantsOnResults: boolean;
  /** How many entrants an announcement would email now. */
  announcementRecipients: number;
  resultsUrl: string;
  timezone: string;
}) {
  const { run, busy } = useJudgingAction();
  const [confirming, setConfirming] = useState<"publish" | "unpublish" | "announce" | null>(null);
  const closed = judgingStatus === "CLOSED";
  const announcement = resultsAnnouncementState({ resultsPublishedAt, resultsAnnouncedAt, emailEntrantsOnResults });
  const announcedEarlier = announcedBefore({ resultsPublishedAt, resultsAnnouncedAt });
  const emailLine = publishedResultsEmailLine(announcement, announcedEarlier);
  return (
    <Card as="section">
      <CardHeader
        title="Results page"
        description="Shows each award's winners with their project titles, names and links. Scores and judges' comments are never public."
        action={<Chip tone={resultsPublishedAt ? "success" : "neutral"}>{resultsPublishedAt ? "Published" : "Not published"}</Chip>}
      />
      {resultsPublishedAt ? (
        <div className="flex flex-col gap-3">
          <p className="text-body-ui text-ink-secondary">Published {formatDayTime(resultsPublishedAt, timezone)}. It follows the event page&apos;s visibility.</p>
          {emailLine ? <p className="text-body-ui text-ink-secondary">{emailLine}</p> : null}
          <div className="flex flex-wrap gap-2.5">
            {announcement === "ready" ? (
              <Button variant="primary" loading={busy === "announce"} onClick={() => setConfirming("announce")}>
                Send results email now…
              </Button>
            ) : null}
            <Button asChild variant="secondary">
              <a href={resultsUrl} target="_blank" rel="noopener noreferrer">
                View results page
                <ExternalLink aria-hidden className="size-4" />
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
            </Button>
            <Button variant="danger" loading={busy === "unpublish"} onClick={() => setConfirming("unpublish")}>
              Unpublish…
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <Callout tone="info">{resultsPublishHint(judgingStatus)}</Callout>
          <p className="text-body-ui text-ink-secondary">{unpublishedResultsEmailLine(emailEntrantsOnResults)}</p>
          <div>
            <Button variant="primary" disabled={!closed} loading={busy === "publish"} onClick={() => setConfirming("publish")}>
              Publish results…
            </Button>
          </div>
        </div>
      )}
      <ConfirmationDialog
        open={confirming === "publish"}
        title="Publish results?"
        message={`The results page goes live with the winners you picked on the Awards tab. ${publishResultsEmailCopy(emailEntrantsOnResults, announcementRecipients, announcedEarlier)} Check the awards first.`}
        confirmLabel="Publish results"
        destructive={false}
        loading={busy === "publish"}
        onConfirm={() =>
          run(
            "publish",
            () => publishJudgingResults(scope),
            emailEntrantsOnResults && announcementRecipients > 0 ? "Results published. Entrants are being emailed." : "Results published.",
            () => setConfirming(null),
          )
        }
        onCancel={() => setConfirming(null)}
      />
      <ConfirmationDialog
        open={confirming === "unpublish"}
        title="Unpublish results?"
        message="The results page is hidden again. Announcement emails that haven't been sent yet are cancelled; ones already delivered can't be recalled."
        confirmLabel="Unpublish"
        loading={busy === "unpublish"}
        onConfirm={() => run("unpublish", () => unpublishJudgingResults(scope), "Results unpublished.", () => setConfirming(null))}
        onCancel={() => setConfirming(null)}
      />
      <ConfirmationDialog
        open={confirming === "announce"}
        title="Email entrants the results?"
        message={sendResultsEmailCopy(announcementRecipients, announcedEarlier)}
        confirmLabel="Send results email"
        destructive={false}
        loading={busy === "announce"}
        onConfirm={() => run("announce", () => sendResultsAnnouncement(scope), "Results email queued.", () => setConfirming(null))}
        onCancel={() => setConfirming(null)}
      />
    </Card>
  );
}
