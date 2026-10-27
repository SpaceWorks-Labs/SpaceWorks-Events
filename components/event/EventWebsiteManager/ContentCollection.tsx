"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Plus, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/display";
import { Field, Input, Dropdown, Textarea } from "@/components/ui/field";
import { cn } from "@/lib/cn";
import {
  uploadEventSpeakerPhoto,
  uploadEventSponsorLogo,
} from "@/app/actions/event-website";
import { RichTextEditor } from "@/components/editor/RichTextEditor";
import { collectionId, contentInput, type ContentKind, type ContentRow, type SaveAction } from "./content";
import { VisibilitySelect, visibilityLabels, visibilityTones } from "./VisibilitySelect";

/** Matches the 6 MB Server Action body limit, with room for the form fields. */
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

export function ContentCollection({
  title,
  kind,
  rows,
  action,
  target,
  pending,
  openAddRequest,
  onSave,
  onDelete,
  onError,
  onDraftChange,
}: {
  title: string;
  kind: ContentKind;
  rows: ContentRow[];
  action: SaveAction;
  target: { organisationSlug: string; eventId: string };
  pending: boolean;
  /** Bumped by the sections list to open the "Add" form. */
  openAddRequest: number;
  onSave: (action: SaveAction, input: unknown) => void;
  onDelete: (row: ContentRow) => void;
  onError: (message: string) => void;
  onDraftChange: (kind: ContentKind, dirty: boolean) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [newItemFormKey, setNewItemFormKey] = useState(0);
  const [formVisibility, setFormVisibility] = useState("PUBLISHED");
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [draftDirty, setDraftDirty] = useState(false);
  const [handledAddRequest, setHandledAddRequest] = useState(openAddRequest);
  const itemName = title === "FAQs" ? "FAQ" : title.slice(0, -1);
  const supportsRichText = kind === "faq" || kind === "speaker";
  const headingId = `${collectionId(kind)}-title`;

  useEffect(() => {
    onDraftChange(kind, draftDirty);
  }, [draftDirty, kind, onDraftChange]);

  const openNewItemForm = () => {
    setNewItemFormKey((key) => key + 1);
    setPhotoFile(null);
    setFormVisibility("PUBLISHED");
    setEditing(null);
    setDraftDirty(false);
    setAdding(true);
  };
  // The sections list asked to add an item: open the form once per request (adjust during render).
  if (openAddRequest !== handledAddRequest) {
    setHandledAddRequest(openAddRequest);
    if (!adding) openNewItemForm();
  }
  const closeForms = () => {
    setPhotoFile(null);
    setAdding(false);
    setEditing(null);
    setDraftDirty(false);
  };
  const submit = async (
    event: FormEvent<HTMLFormElement>,
    row?: ContentRow,
  ) => {
    const formElement = event.currentTarget;
    event.preventDefault();
    let values = row?.values ?? { sortOrder: rows.length };
    if ((kind === "speaker" || kind === "sponsor") && photoFile) {
      const assetLabel = kind === "speaker" ? "speaker photo" : "sponsor logo";
      // Larger files exceed the Server Action body limit and throw instead of returning an error.
      if (photoFile.size > MAX_PHOTO_BYTES) {
        onError(`The ${assetLabel} must be 5 MB or smaller.`);
        return;
      }
      setUploadingPhoto(true);
      const photo = new FormData();
      photo.set("organisationSlug", target.organisationSlug);
      photo.set("eventId", target.eventId);
      photo.set("file", photoFile);
      let upload: Awaited<ReturnType<typeof uploadEventSpeakerPhoto>>;
      try {
        upload =
          kind === "speaker"
            ? await uploadEventSpeakerPhoto(photo)
            : await uploadEventSponsorLogo(photo);
      } catch {
        upload = { ok: false, error: `Could not upload the ${assetLabel}.` };
      } finally {
        setUploadingPhoto(false);
      }
      if (!upload.ok) {
        onError(upload.error);
        return;
      }
      if (!upload.data) {
        onError(`Could not upload the ${assetLabel}.`);
        return;
      }
      values = {
        ...values,
        [kind === "speaker" ? "photoUrl" : "logoUrl"]: upload.data.url,
      };
      setPhotoFile(null);
    }
    onSave(
      action,
      contentInput(kind, target, values, row?.id, new FormData(formElement)),
    );
    closeForms();
  };
  const markDraft = () => setDraftDirty(true);
  const photoPicker =
    kind === "speaker" || kind === "sponsor" ? (
      <div className="flex flex-wrap items-center gap-2.5">
        <label className={cn("inline-flex min-h-9 cursor-pointer items-center gap-1.5 rounded-control border border-line bg-panel px-3.5 text-sm font-semibold text-ink transition-colors hover:bg-subtle focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-(--yy-focus)", (pending || uploadingPhoto) && "pointer-events-none opacity-50")}>
          <Upload aria-hidden className="size-4" />
          Choose {kind === "speaker" ? "speaker photo" : "sponsor logo"}
          <input
            className="sr-only"
            type="file"
            accept="image/jpeg,image/png,image/webp"
            disabled={pending || uploadingPhoto}
            onChange={(event) => setPhotoFile(event.target.files?.[0] ?? null)}
          />
        </label>
        <span className="text-caption text-ink-muted wrap-anywhere">
          {photoFile ? photoFile.name : "JPEG, PNG, or WebP · up to 5 MB"}
        </span>
      </div>
    ) : null;
  const destinationUrlField = (row?: ContentRow) =>
    kind === "speaker" || kind === "sponsor" ? (
      <Field label="Destination URL" helperText={`Where guests go when they select the ${kind === "speaker" ? "speaker photo" : "sponsor logo"}.`}>
        <Input name="websiteUrl" type="url" defaultValue={String(row?.values.websiteUrl ?? "")} placeholder="https://example.com" />
      </Field>
    ) : null;
  const metadataFields = (row?: ContentRow) => (
    <>
      {kind === "highlight" ? (
        <Field label="Icon" helperText="Optional short icon or emoji shown with this highlight.">
          <Input name="icon" defaultValue={String(row?.values.icon ?? "")} />
        </Field>
      ) : null}
      {kind === "speaker" ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Headline"><Input name="headline" defaultValue={String(row?.values.headline ?? "")} /></Field>
          <Field label="Organisation"><Input name="organisation" defaultValue={String(row?.values.organisation ?? "")} /></Field>
          <Field label="LinkedIn URL"><Input name="linkedinUrl" type="url" defaultValue={String(row?.values.linkedinUrl ?? "")} /></Field>
          <Field label="X URL"><Input name="xUrl" type="url" defaultValue={String(row?.values.xUrl ?? "")} /></Field>
        </div>
      ) : null}
      {kind === "sponsor" ? (
        <Field label="Sponsor tier">
          <Dropdown name="tier" defaultValue={String(row?.values.tier ?? "PARTNER")}>
            <option value="PLATINUM">Platinum</option>
            <option value="GOLD">Gold</option>
            <option value="SILVER">Silver</option>
            <option value="PARTNER">Partner</option>
            <option value="COMMUNITY_PARTNER">Community partner</option>
          </Dropdown>
        </Field>
      ) : null}
    </>
  );
  const itemForm = (row?: ContentRow) => (
    <>
      <Field label={kind === "faq" ? "Question" : "Name"} required>
        <Input name="title" defaultValue={row?.title} />
      </Field>
      {photoPicker}
      {destinationUrlField(row)}
      {metadataFields(row)}
      {kind === "resource" ? (
        <Field label="Resource link" required helperText="Paste the public URL guests should open.">
          <Input name="externalUrl" defaultValue={row ? String(row.values.externalUrl ?? "") : undefined} />
        </Field>
      ) : null}
      {supportsRichText ? (
        <RichTextEditor
          name="description"
          label={kind === "faq" ? "Answer" : "Description"}
          defaultValue={row?.description}
          minHeight={88}
        />
      ) : (
        <Field label="Description">
          <Textarea name="description" rows={2} defaultValue={row?.description} />
        </Field>
      )}
      <VisibilitySelect value={formVisibility} onChange={setFormVisibility} />
    </>
  );
  return (
    <section id={collectionId(kind)} aria-labelledby={headingId} tabIndex={-1} className="scroll-mt-24 rounded-xl border border-line bg-panel p-5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--yy-focus)">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 id={headingId} className="text-title text-ink">{title}</h3>
          <p className="text-caption text-ink-muted">{rows.length === 0 ? "Nothing added yet" : `${rows.length} added`}</p>
        </div>
        <Button
          size="sm"
          variant="secondary"
          startIcon={adding ? undefined : <Plus />}
          aria-expanded={adding}
          onClick={() => {
            if (adding) closeForms();
            else openNewItemForm();
          }}
        >
          {adding ? "Close" : `Add ${itemName}`}
        </Button>
      </div>
      <form
        key={newItemFormKey}
        aria-label={`New ${itemName}`}
        hidden={!adding}
        onInputCapture={markDraft}
        onChangeCapture={markDraft}
        onSubmit={(event) => void submit(event)}
        className="mt-4 flex flex-col gap-4 rounded-xl border border-line bg-subtle p-4"
      >
        {itemForm()}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="primary" disabled={pending || uploadingPhoto}>
            Add {itemName}
          </Button>
          <Button variant="quiet" onClick={closeForms} disabled={uploadingPhoto}>
            Cancel
          </Button>
        </div>
      </form>
      {rows.length ? (
        <ul className="mt-3 flex flex-col gap-2">
          {rows.map((row) => (
            <li key={row.id} className="rounded-xl border border-line px-3.5 py-2.5">
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <span className="truncate text-[15px] font-semibold text-ink">{row.title}</span>
                  <Chip size="sm" tone={visibilityTones[row.visibility] ?? "neutral"}>{visibilityLabels[row.visibility] ?? row.visibility.toLowerCase()}</Chip>
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button
                    size="sm"
                    variant="quiet"
                    aria-expanded={editing === row.id}
                    aria-label={`Edit ${row.title}`}
                    onClick={() => {
                      const nextEditing = editing === row.id ? null : row.id;
                      setEditing(nextEditing);
                      setAdding(false);
                      setPhotoFile(null);
                      setDraftDirty(false);
                      if (nextEditing) setFormVisibility(row.visibility);
                    }}
                  >
                    Edit
                  </Button>
                  <Button size="sm" variant="dangerQuiet" aria-label={`Remove ${row.title}`} onClick={() => onDelete(row)} disabled={pending}>
                    Remove
                  </Button>
                </div>
              </div>
              <form
                aria-label={`Edit ${row.title}`}
                hidden={editing !== row.id}
                onInputCapture={markDraft}
                onChangeCapture={markDraft}
                onSubmit={(event) => void submit(event, row)}
                className="mt-3 flex flex-col gap-4 rounded-xl border border-line bg-subtle p-4"
              >
                {itemForm(row)}
                <div className="flex flex-wrap gap-2">
                  <Button type="submit" variant="primary" disabled={pending || uploadingPhoto}>
                    Save changes
                  </Button>
                  <Button variant="quiet" onClick={closeForms} disabled={pending || uploadingPhoto}>
                    Cancel
                  </Button>
                </div>
              </form>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
