"use client";

import type { Dispatch, SetStateAction } from "react";
import { EventStatus } from "@prisma/client";
import type { EventClientDto } from "@/lib/eventDto";
import { Chip } from "@/components/ui/display";
import { Field, Input } from "@/components/ui/field";
import { RichTextEditor } from "@/components/editor/RichTextEditor";
import { ImageUploadPicker } from "@/components/forms/ImageUploadPicker";
import { FormCard } from "./cards";

/** Basics: title, tagline, event page logo, about text and tags. */
export function BasicsCard({
  event,
  page,
  pending,
  tagsPreview,
  setTagsPreview,
  setPageLogoFile,
  setPageLogoPreviewUrl,
  setDirty,
}: {
  event: EventClientDto;
  page: { tagline: string; logoUrl: string | null; aboutHtml: string } | null;
  pending: boolean;
  tagsPreview: string[];
  setTagsPreview: Dispatch<SetStateAction<string[]>>;
  setPageLogoFile: Dispatch<SetStateAction<File | null>>;
  setPageLogoPreviewUrl: Dispatch<SetStateAction<string>>;
  setDirty: Dispatch<SetStateAction<boolean>>;
}) {
  return (
  <FormCard
    title={<>Basics<Chip size="sm" tone={event.status === EventStatus.DRAFT ? "neutral" : "success"}>{event.status === EventStatus.DRAFT ? "Draft" : "Published"}</Chip></>}
    description="Update the public-facing title and introduction."
  >
    <Field label="Title" required>
      <Input name="title" defaultValue={event.title} />
    </Field>
    <Field label="Tagline" helperText="A short line beneath the event title.">
      <Input name="pageTagline" defaultValue={page?.tagline ?? ""} />
    </Field>
    <ImageUploadPicker
      initialUrl={page?.logoUrl}
      label="Event page logo"
      placeholder="Your event page logo will appear here."
      disabled={pending}
      onChange={(file, previewUrl) => {
        setPageLogoFile(file);
        setPageLogoPreviewUrl(previewUrl);
        setDirty(true);
      }}
    />
    <RichTextEditor
      name="pageAboutHtml"
      label="About the event"
      defaultValue={page?.aboutHtml ?? ""}
      helperText="Required. Use the toolbar to format text—no HTML needed."
      minHeight={140}
    />
    <div className="flex flex-col gap-2">
      <Field label="Tags" helperText="Comma-separated (eg: workshop, meetup, ai). Used in global search.">
        <Input
          name="tags"
          defaultValue={tagsPreview.join(", ")}
          onChange={(e) => {
            const parts = e.currentTarget.value
              .split(/[,\n]/g)
              .map((s) => s.trim().toLowerCase())
              .map((s) => s.replace(/\s+/g, " "))
              .filter(Boolean)
              .slice(0, 12);
            setTagsPreview(Array.from(new Set(parts)));
          }}
        />
      </Field>
      {tagsPreview.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {tagsPreview.slice(0, 12).map((t) => (
            <Chip key={t} size="sm" tone="outline">{t}</Chip>
          ))}
        </div>
      ) : null}
    </div>
  </FormCard>
  );
}
