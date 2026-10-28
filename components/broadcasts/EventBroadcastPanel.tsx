"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { BroadcastAttendanceFilter, RsvpStatus } from "@prisma/client";
import { FlaskConical, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/display";
import { Field, Input } from "@/components/ui/field";
import { Tooltip } from "@/components/ui/menu";
import { countBroadcastRecipients, previewEventBroadcast, sendEventBroadcast, sendEventBroadcastTest } from "@/app/actions/broadcasts";
import { BROADCAST_STARTER_TEMPLATES, BROADCAST_SUBJECT_MAX, broadcastHtmlToText, describeBroadcastAudience } from "@/lib/broadcastTemplate";
import type { EventBroadcastDraftDto } from "@/lib/broadcastDraftAutosave";
import { useToast } from "@/components/feedback/ToastProvider";
import { SendConfirmDialog } from "./SendConfirmDialog";
import { recipientDots, recipientSummary, sendBarLabel } from "@/components/event-dashboard/emails/recipients";
import { BroadcastEmailEditor } from "./BroadcastEmailEditor";
import type { BroadcastDesignId } from "@/lib/email/broadcastDesigns";
import { AudienceSection } from "./EventBroadcastPanel/AudienceSection";
import { HistorySection } from "./EventBroadcastPanel/HistorySection";
import { PreviewSection } from "./EventBroadcastPanel/PreviewSection";
import { MORE_TEMPLATES, StepHeading, SUBJECT_PLACEHOLDERS, cardClass, type BroadcastHistoryRow } from "./EventBroadcastPanel/shared";
import { TemplateSection } from "./EventBroadcastPanel/TemplateSection";
import { DraftStatusBar, ReplaceDraftDialog } from "./EventBroadcastPanel/DraftControls";
import { initialComposer, type ComposerContent } from "./EventBroadcastPanel/draft";
import { useBroadcastDraft } from "./EventBroadcastPanel/useBroadcastDraft";
import { HelpLink } from "@/components/help/HelpLink";

export type { BroadcastHistoryRow } from "./EventBroadcastPanel/shared";

const UNDO_SECONDS = 5;
type SendPayload = ComposerContent & { statuses: RsvpStatus[]; count: number };

export function EventBroadcastPanel(props: {
  organisationSlug: string;
  eventId: string;
  statusCounts: Record<RsvpStatus, number>;
  history: BroadcastHistoryRow[];
  /** Event branding for the design thumbnails; the server renders the real thing. */
  brand: { accentColor: string | null; coverImageUrl: string | null };
  /** The signed-in organiser's own saved draft for this event, restored into the composer. */
  draft: EventBroadcastDraftDto | null;
}) {
  const { organisationSlug, eventId, statusCounts, history, brand, draft } = props;
  const router = useRouter();
  const { showToast } = useToast();
  // Only the first render's draft matters: later server renders (after a send)
  // must not overwrite what the organiser is editing.
  const [initial] = useState(() => initialComposer(draft));

  const [templateId, setTemplateId] = useState<string>(initial.templateId ?? "");
  const [showAllTemplates, setShowAllTemplates] = useState(false);
  const [statuses, setStatuses] = useState<RsvpStatus[]>([...initial.statuses]);
  const [attendance, setAttendance] = useState<BroadcastAttendanceFilter>(initial.attendance);
  const [subject, setSubject] = useState(initial.subject);
  const [body, setBody] = useState(initial.body);
  const [countState, setCountState] = useState<{ key: string; count: number; error: string | null }>({ key: "", count: 0, error: null });
  const [preview, setPreview] = useState<{ key: string; subject: string; html: string; error: string | null }>({ key: "", subject: "", html: "", error: null });
  const [previewWidth, setPreviewWidth] = useState<"desktop" | "mobile">("desktop");
  const [design, setDesign] = useState<BroadcastDesignId>(initial.design);
  const [confirmOpen, setConfirmOpen] = useState(false);
  // After confirming, sending waits UNDO_SECONDS so a mistake can still be undone.
  const [countdown, setCountdown] = useState<{ left: number; count: number } | null>(null);
  const sendTimer = useRef<{ interval: ReturnType<typeof setInterval>; payload: SendPayload } | null>(null);
  const [pending, startTransition] = useTransition();
  const subjectRef = useRef<HTMLInputElement | null>(null);

  const content = useMemo<ComposerContent>(
    () => ({ subject, body, design, statuses, attendance, templateId: templateId || null }),
    [subject, body, design, statuses, attendance, templateId],
  );
  const drafts = useBroadcastDraft({
    organisationSlug,
    eventId,
    draft,
    initial,
    content,
    apply: (next) => {
      setTemplateId(next.templateId ?? "");
      setSubject(next.subject);
      setBody(next.body);
      setStatuses([...next.statuses]);
      setAttendance(next.attendance);
      setDesign(next.design);
    },
  });

  const audienceText = describeBroadcastAudience(statuses, attendance);
  const audienceKey = `${[...statuses].sort().join(",")}|${attendance}`;
  const countReady = statuses.length === 0 || countState.key === audienceKey;
  const recipientCount: number | null = statuses.length === 0 ? 0 : countReady ? countState.count : null;
  const countError = countReady ? countState.error : null;

  const previewKey = `${design}\u0000${subject}\u0000${body}`;
  const previewReady = preview.key === previewKey;
  const hasContent = subject.trim().length > 0 && broadcastHtmlToText(body).trim().length > 0;

  const totalRegistrations = Object.values(statusCounts).reduce((sum, value) => sum + value, 0);
  const reach = recipientDots(recipientCount ?? 0, totalRegistrations);
  const summary = recipientSummary(recipientCount);
  const moreOpen = showAllTemplates || MORE_TEMPLATES.some((template) => template.id === templateId);

  // Recount on the server whenever the audience changes. The count is also
  // recomputed inside the send transaction, so this is guidance, not the truth.
  useEffect(() => {
    if (statuses.length === 0) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      const result = await countBroadcastRecipients({ organisationSlug, eventId, statuses, attendance });
      if (cancelled) return;
      setCountState(result.ok
        ? { key: audienceKey, count: result.data?.count ?? 0, error: null }
        : { key: audienceKey, count: 0, error: result.error });
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [organisationSlug, eventId, statuses, attendance, audienceKey]);

  // The preview is rendered by the server with the real email template, so
  // what the organiser sees is exactly what a recipient receives.
  useEffect(() => {
    if (!hasContent) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      const result = await previewEventBroadcast({ organisationSlug, eventId, subject, body, design });
      if (cancelled) return;
      setPreview(result.ok
        ? { key: previewKey, subject: result.data?.subject ?? "", html: result.data?.html ?? "", error: null }
        : { key: previewKey, subject: "", html: "", error: result.error });
    }, 500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [organisationSlug, eventId, subject, body, design, hasContent, previewKey]);

  function toggleStatus(value: RsvpStatus) {
    setStatuses((current) => (current.includes(value) ? current.filter((status) => status !== value) : [...current, value]));
  }

  function applyTemplate(id: string) {
    const template = BROADCAST_STARTER_TEMPLATES.find((candidate) => candidate.id === id);
    if (template) drafts.requestReplace({ kind: "template", id, name: template.name });
  }

  function insertSubjectPlaceholder(token: string) {
    const input = subjectRef.current;
    const start = input?.selectionStart ?? subject.length;
    const end = input?.selectionEnd ?? subject.length;
    const next = `${subject.slice(0, start)}${token}${subject.slice(end)}`;
    if (next.length > BROADCAST_SUBJECT_MAX) return;
    setSubject(next);
    requestAnimationFrame(() => {
      input?.focus();
      input?.setSelectionRange(start + token.length, start + token.length);
    });
  }

  function loadFromHistory(row: BroadcastHistoryRow) {
    drafts.requestReplace({ kind: "history", row });
  }

  // Sending waits for the preview of the current edit, so the review step
  // always shows the subject and design that will actually go out.
  const canSend = !pending && statuses.length > 0 && hasContent && (recipientCount ?? 0) > 0 && previewReady && !preview.error;
  function startCountdown(payload: SendPayload) {
    drafts.sendStarted();
    let left = UNDO_SECONDS;
    setCountdown({ left, count: payload.count });
    const interval = setInterval(() => {
      left -= 1;
      if (left > 0) return setCountdown({ left, count: payload.count });
      clearInterval(interval);
      sendTimer.current = null;
      setCountdown(null);
      startTransition(async () => {
        const result = await sendEventBroadcast({ organisationSlug, eventId, statuses: payload.statuses, attendance: payload.attendance, subject: payload.subject, body: payload.body, design: payload.design });
        if (!result.ok) {
          drafts.sendStopped();
          return showToast(result.error, "error");
        }
        drafts.sent(payload);
        showToast(`Queued for ${result.data?.recipientCount ?? 0} recipients`, "success");
        router.refresh();
      });
    }, 1000);
    sendTimer.current = { interval, payload };
  }

  function undoSend() {
    if (sendTimer.current) clearInterval(sendTimer.current.interval);
    sendTimer.current = null;
    setCountdown(null);
    drafts.sendStopped();
    showToast("Sending cancelled. Nothing was sent.", "success");
  }

  // Leaving the page during the countdown cancels the send rather than firing it unseen.
  useEffect(() => () => {
    if (sendTimer.current) clearInterval(sendTimer.current.interval);
  }, []);

  const sendLabel = recipientCount && recipientCount > 0 ? `Send to ${recipientCount} ${recipientCount === 1 ? "person" : "people"}` : "Send";

  return (
    <div className="flex flex-col gap-6">
      <Callout tone="info" action={<HelpLink article="guests/emailing-guests" />}>
        Emails go only to people who already registered for this event. Messages are queued and delivered in the background, a few at a time, so large audiences take a few minutes. Send yourself a test first.
      </Callout>

      <TemplateSection templateId={templateId} applyTemplate={applyTemplate} pending={pending} moreOpen={moreOpen} setShowAllTemplates={setShowAllTemplates} />

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-5">
          <AudienceSection
            statuses={statuses}
            attendance={attendance}
            setAttendance={setAttendance}
            toggleStatus={toggleStatus}
            statusCounts={statusCounts}
            pending={pending}
            reach={reach}
            summary={summary}
            countError={countError}
            recipientCount={recipientCount}
            audienceText={audienceText}
          />

          <section aria-labelledby="broadcast-step-message" className={cardClass}>
            <StepHeading step={3} id="broadcast-step-message" title="Write it" />
            <Field label="Subject" required helperText={`${subject.length}/${BROADCAST_SUBJECT_MAX}`}>
              <Input ref={subjectRef} value={subject} onChange={(e) => setSubject(e.target.value)} disabled={pending} maxLength={BROADCAST_SUBJECT_MAX} />
            </Field>
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-caption text-ink-muted">Subject placeholders:</span>
              {SUBJECT_PLACEHOLDERS.map((placeholder) => (
                <Tooltip key={placeholder.token} content={placeholder.description}>
                  <button
                    type="button"
                    onClick={() => insertSubjectPlaceholder(placeholder.token)}
                    disabled={pending}
                    className="inline-flex min-h-8 items-center rounded-full border border-line-strong bg-panel px-3 text-[13px] font-semibold text-ink transition-colors hover:bg-subtle disabled:pointer-events-none disabled:border-line disabled:bg-surface disabled:text-ink-muted"
                  >
                    {placeholder.label}
                  </button>
                </Tooltip>
              ))}
            </div>
            <BroadcastEmailEditor value={body} onChange={setBody} disabled={pending} />
            <DraftStatusBar
              state={drafts.state}
              statusText={drafts.statusText}
              busy={pending || countdown !== null}
              replacing={drafts.replacing}
              onSave={drafts.saveNow}
              onDiscard={() => drafts.requestReplace({ kind: "discard" })}
            />
          </section>
        </div>

        <div className="flex min-w-0 flex-col gap-5">
          <PreviewSection previewWidth={previewWidth} setPreviewWidth={setPreviewWidth} design={design} setDesign={setDesign} brand={brand} hasContent={hasContent} preview={preview} previewReady={previewReady} />

          <HistorySection history={history} pending={pending} loadFromHistory={loadFromHistory} />
        </div>
      </div>

      {countdown !== null ? (
        <div role="status" className="yy-dark-band sticky bottom-4 z-10 flex items-center gap-3 rounded-full bg-[var(--yy-inverse-surface)] py-2.5 pl-6 pr-3 text-ink shadow-float">
          <p className="flex-1 text-sm text-ink">
            Sending to {countdown.count} {countdown.count === 1 ? "person" : "people"} in <span className="font-bold tabular-nums">{countdown.left}</span>…
          </p>
          <Button variant="inverse" onClick={undoSend}>
            Undo
          </Button>
        </div>
      ) : (
      <div className="yy-dark-band sticky bottom-4 z-10 flex flex-col gap-2 rounded-xl bg-[var(--yy-inverse-surface)] p-3 text-ink shadow-float sm:flex-row sm:items-center sm:rounded-full sm:py-2.5 sm:pl-6 sm:pr-3">
        <p aria-live="polite" className="flex-1 px-1 text-sm text-ink-secondary sm:px-0">
          {sendBarLabel({ count: recipientCount, hasStatuses: statuses.length > 0, hasContent })}
        </p>
        <div className="flex flex-col-reverse gap-2 min-[420px]:flex-row min-[420px]:items-center">
          <Button
            variant="quiet"
            className="justify-center px-3 text-ink"
            startIcon={<FlaskConical />}
            disabled={pending || !hasContent}
            onClick={() => {
              startTransition(async () => {
                const result = await sendEventBroadcastTest({ organisationSlug, eventId, subject, body, design });
                if (!result.ok) return showToast(result.error, "error");
                showToast(`Test email queued to ${result.data?.to ?? "your address"}`, "success");
              });
            }}
          >
            Send a test to me
          </Button>
          <Button variant="inverse" startIcon={<Send />} disabled={!canSend} onClick={() => setConfirmOpen(true)}>
            {sendLabel}
          </Button>
        </div>
      </div>
      )}

      <ReplaceDraftDialog pending={drafts.pendingReplace} replacing={drafts.replacing} onCancel={drafts.cancelReplace} onConfirm={drafts.confirmReplace} />

      <SendConfirmDialog
        open={confirmOpen}
        recipientCount={recipientCount ?? 0}
        audienceText={audienceText}
        subject={(previewReady && preview.subject) || subject}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => {
          setConfirmOpen(false);
          // Snapshot what was reviewed; later edits during the countdown don't change it.
          startCountdown({ ...content, statuses: [...statuses], count: recipientCount ?? 0 });
        }}
      />
    </div>
  );
}
