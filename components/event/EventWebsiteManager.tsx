"use client";

import { useCallback, useState, useTransition, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowUpRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/display";
import { ACCENT_PRESETS, DEFAULT_EVENT_ACCENT, normalizeAccentHex } from "@/lib/theme/accent";
import {
  deleteWebsiteContent,
  saveEventPage,
  saveFaq,
  saveHighlight,
  saveResource,
  saveSpeaker,
  saveSponsor,
} from "@/app/actions/event-website";
import { ConfirmationDialog } from "@/components/feedback/ConfirmationDialog";
import { useToast } from "@/components/feedback/ToastProvider";
import { useUnsavedChangesGuard } from "@/components/forms/useUnsavedChangesGuard";
import { useEventTabs } from "@/components/event-dashboard/EventDashboardTabs";
import { UnsavedChangesBar } from "@/components/event-dashboard/event-page/UnsavedChangesBar";
import {
  countPageChanges,
  normalizeSections,
  parseAccentInput,
  type PageSection,
  type PageSettings,
} from "@/components/event-dashboard/event-page/summary";
import { CONTENT_FOR_SECTION, collectionId, type ContentKind, type ContentRow, type SaveAction } from "./EventWebsiteManager/content";
import { ContentCollection } from "./EventWebsiteManager/ContentCollection";
import { ColourSection } from "./EventWebsiteManager/ColourSection";
import { SectionsList } from "./EventWebsiteManager/SectionsList";

/** Read-only facts for the section notes and the live phone preview (computed on the server). */
export type EventPagePreviewData = {
  title: string;
  dateLine: string;
  privacyType: string;
  location: string;
  isOnline: boolean;
  aboutExcerpt: string;
  sessionCount: number;
  /** First few published sessions: start time + title. */
  sessionLines: Array<{ lead: string; text: string }>;
  /** Link to the schedule workspace, only when the viewer may manage it. */
  scheduleHref: string | null;
  crewShown?: number; // Crew members marked to show on the page (docs/CREW.md).
};

type Props = {
  organisationSlug: string;
  eventId: string;
  eventSlug: string;
  /** The Details sub-tab is owner/admin only; co-organisers with EDIT_DETAILS edit page content here. */
  canEditDetails?: boolean;
  page: {
    tagline: string;
    logoUrl: string | null;
    accentColor: string | null;
    aboutHtml: string;
    sections: PageSection[];
  } | null;
  highlights: ContentRow[];
  speakers: ContentRow[];
  sponsors: ContentRow[];
  resources: ContentRow[];
  faqs: ContentRow[];
  preview?: EventPagePreviewData;
  /** Rendered first in the editor column (e.g. the programme card). */
  programme?: ReactNode;
};

export function EventWebsiteManager(props: Props) {
  const router = useRouter();
  const { openTab } = useEventTabs();
  const { showToast } = useToast();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{
    kind: ContentKind;
    row: ContentRow;
  } | null>(null);
  const [baseline, setBaseline] = useState<PageSettings>(() => ({
    accentColor: props.page?.accentColor ?? "",
    sections: normalizeSections(props.page?.sections),
  }));
  const [accentColor, setAccentColor] = useState(baseline.accentColor);
  const [sections, setSections] = useState<readonly PageSection[]>(baseline.sections);
  const [contentDrafts, setContentDrafts] = useState<ReadonlySet<ContentKind>>(() => new Set());
  const [addRequests, setAddRequests] = useState<Record<ContentKind, number>>({ highlight: 0, speaker: 0, sponsor: 0, resource: 0, faq: 0 });

  const changeCount = countPageChanges(baseline, { accentColor, sections });
  const pageDirty = changeCount > 0;
  useUnsavedChangesGuard((pageDirty || contentDrafts.size > 0) && !pending);

  const accent = parseAccentInput(accentColor);
  const accentPreview = accent.valid && accent.value ? accent.value : accent.valid ? DEFAULT_EVENT_ACCENT : normalizeAccentHex(baseline.accentColor);
  const customAccent = accent.valid && Boolean(accent.value) && !ACCENT_PRESETS.some((preset) => preset.hex === accent.value);

  const onDraftChange = useCallback(
    (kind: ContentKind, dirty: boolean) =>
      setContentDrafts((current) => {
        if (current.has(kind) === dirty) return current;
        const next = new Set(current);
        if (dirty) next.add(kind);
        else next.delete(kind);
        return next;
      }),
    [],
  );

  const target = {
    organisationSlug: props.organisationSlug,
    eventId: props.eventId,
  };
  // `announce` also toasts the outcome, for saves started from the floating bar far below the callouts.
  const save = (action: SaveAction, input: unknown, onSuccess?: () => void, announce = false) =>
    startTransition(async () => {
      const result = await action(input);
      if (!result.ok) {
        setSaved(false);
        setError(result.error || "Could not save your changes.");
        if (announce) showToast(result.error || "Could not save your changes.", "error");
      } else {
        if (announce) showToast("Event page saved", "success");
        setError("");
        setSaved(true);
        onSuccess?.();
        router.refresh();
      }
    });
  const touch = () => setSaved(false);
  const moveSection = (index: number, direction: -1 | 1) => {
    touch();
    setSections((current) => {
      const nextIndex = index + direction;
      if (nextIndex < 0 || nextIndex >= current.length) return current;
      const next = [...current];
      [next[index], next[nextIndex]] = [next[nextIndex]!, next[index]!];
      return next.map((section, sortOrder) => ({ ...section, sortOrder }));
    });
  };
  const savePage = () => {
    if (!accent.valid) {
      setError("Use a hex colour such as #006E63, or choose a preset.");
      showToast("Use a hex colour such as #006E63, or choose a preset.", "error");
      return;
    }
    const draft = { accentColor: accent.value, sections };
    save(
      saveEventPage,
      {
        ...target,
        tagline: props.page?.tagline ?? "",
        logoUrl: props.page?.logoUrl ?? "",
        accentColor: accent.value,
        aboutHtml: props.page?.aboutHtml ?? "",
        sections,
      },
      () => {
        setBaseline(draft);
        setAccentColor(draft.accentColor);
      },
      true,
    );
  };
  const discard = () => {
    setAccentColor(baseline.accentColor);
    setSections(baseline.sections);
    setError("");
  };
  const remove = (kind: ContentKind) => (row: ContentRow) =>
    setDeleteTarget({ kind, row });

  const preview = props.preview;
  const noteData = {
    highlights: props.highlights,
    speakers: props.speakers,
    sponsors: props.sponsors,
    resources: props.resources,
    faqs: props.faqs,
    sessionCount: preview?.sessionCount ?? 0,
    location: preview?.location ?? "",
    isOnline: preview?.isOnline ?? false, crewShown: preview?.crewShown ?? 0,
  };
  const rowsFor: Record<ContentKind, ContentRow[]> = {
    highlight: props.highlights,
    speaker: props.speakers,
    sponsor: props.sponsors,
    resource: props.resources,
    faq: props.faqs,
  };

  const goToCollection = (kind: ContentKind, add: boolean) => {
    if (add) setAddRequests((current) => ({ ...current, [kind]: current[kind] + 1 }));
    const node = document.getElementById(collectionId(kind));
    if (!node) return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    node.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
    node.focus({ preventScroll: true });
  };

  const sectionAction = (type: string, label: string): ReactNode => {
    const kind = CONTENT_FOR_SECTION[type];
    const linkClass = "inline-flex min-h-9 items-center whitespace-nowrap rounded-full px-1.5 text-sm font-semibold text-ink underline-offset-4 hover:underline";
    if (kind) {
      const empty = rowsFor[kind].length === 0;
      return (
        <button type="button" className={linkClass} onClick={() => goToCollection(kind, empty)}>
          {empty ? "Add" : "Edit"}
          <span className="sr-only"> {label}</span>
        </button>
      );
    }
    if ((type === "ABOUT" || type === "VENUE") && props.canEditDetails !== false) {
      return (
        <button type="button" className={linkClass} onClick={() => openTab("page", "details")}>
          Edit in Details
          <span className="sr-only"> ({label})</span>
        </button>
      );
    }
    // Crew profiles are managed with the guest list (Guests → Crew), not inline.
    if (type === "CREW") return <button type="button" className={linkClass} onClick={() => openTab("guests", "crew")}>Manage in Guests<span className="sr-only"> ({label})</span></button>;
    if (type === "SCHEDULE" && preview?.scheduleHref) {
      return (
        <Link href={preview.scheduleHref} className={linkClass}>
          Open schedule
        </Link>
      );
    }
    return null;
  };

  const collections: Array<{ title: string; kind: ContentKind; action: SaveAction }> = [
    { title: "Highlights", kind: "highlight", action: saveHighlight },
    { title: "Speakers", kind: "speaker", action: saveSpeaker },
    { title: "Sponsors", kind: "sponsor", action: saveSponsor },
    { title: "Resources", kind: "resource", action: saveResource },
    { title: "FAQs", kind: "faq", action: saveFaq },
  ];

  return (
    <div className="flex flex-col gap-5">
      <div className="flex min-w-0 flex-col gap-5">
          <Button asChild variant="secondary" size="sm" className="self-end">
            <a href={`/${props.organisationSlug}/${props.eventSlug}`} target="_blank" rel="noopener noreferrer">
              Open public page
              <ArrowUpRight aria-hidden className="size-4" />
              <span className="sr-only">(opens in a new tab)</span>
            </a>
          </Button>
          {error ? <Callout tone="danger" role="alert">{error}</Callout> : null}
          {saved ? <Callout tone="success" role="status">Changes saved.</Callout> : null}
          {props.programme}

          <ColourSection
            accent={accent}
            accentPreview={accentPreview}
            customAccent={customAccent}
            setAccentColor={setAccentColor}
            touch={touch}
          />

          <SectionsList
            sections={sections}
            setSections={setSections}
            noteData={noteData}
            sectionAction={sectionAction}
            touch={touch}
            moveSection={moveSection}
          />

          <div className="mt-2">
            <h2 className="text-h4 text-ink">Section content</h2>
            <p className="mt-0.5 text-body-ui text-ink-muted">Each item is saved on its own. Drafts and hidden items stay off the public page.</p>
          </div>
          {collections.map((collection) => (
            <ContentCollection
              key={collection.kind}
              title={collection.title}
              kind={collection.kind}
              rows={rowsFor[collection.kind]}
              action={collection.action}
              target={target}
              pending={pending}
              openAddRequest={addRequests[collection.kind]}
              onSave={(action, input) => save(action, input)}
              onDelete={remove(collection.kind)}
              onError={(message) => {
                // The callout sits at the top of the page, out of view of the open form.
                setError(message);
                showToast(message, "error");
              }}
              onDraftChange={onDraftChange}
            />
          ))}
        </div>

      <UnsavedChangesBar visible={pageDirty} count={changeCount} pending={pending} onDiscard={discard} onSave={savePage} />

      <ConfirmationDialog
        open={Boolean(deleteTarget)}
        title="Remove event-page content?"
        message={`Remove “${deleteTarget?.row.title ?? "this item"}” from the event page? This cannot be undone.`}
        confirmLabel="Remove"
        loading={pending}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (!deleteTarget) return;
          const current = deleteTarget;
          setDeleteTarget(null);
          save(deleteWebsiteContent, {
            ...target,
            kind: current.kind,
            id: current.row.id,
          });
        }}
      />
    </div>
  );
}
