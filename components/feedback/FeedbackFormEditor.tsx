"use client";

import { useState, useTransition, type ReactNode } from "react";
import type { RegistrationFieldType } from "@prisma/client";
import { Award, Copy, LayoutTemplate, Pencil, Plus, Trash2 } from "lucide-react";
import { MoodTile } from "@/components/brand/MoodTile";
import { Button, IconButton } from "@/components/ui/button";
import { Switch } from "@/components/ui/choice";
import { Callout, Chip, EmptyState } from "@/components/ui/display";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Field as FormField, Input } from "@/components/ui/field";
import { applyFeedbackTemplate, deleteFeedbackField, saveFeedbackField, saveFeedbackSettings } from "@/app/actions/feedback-form";
import { ConfirmationDialog } from "@/components/feedback/ConfirmationDialog";
import { useUnsavedChangesGuard } from "@/components/forms/useUnsavedChangesGuard";
import { questionTypeLabel } from "@/components/event-dashboard/feedback/helpers";
import { type FeedbackTemplate } from "@/lib/feedbackTemplates";

import { CertificateBuilder } from "./CertificateBuilder";
import { parseCertificateTemplate } from "@/lib/certificateTemplate";
import { CertificatePreview } from "./FeedbackFormEditor/CertificatePreview";
import { QuestionDialog } from "./FeedbackFormEditor/QuestionDialog";
import { TemplateDialog } from "./FeedbackFormEditor/TemplateDialog";
import type { Field } from "./FeedbackFormEditor/field";
import { HelpLink } from "@/components/help/HelpLink";

const card = "flex flex-col gap-4 rounded-xl border border-line bg-panel p-5";

export function FeedbackFormEditor(props: {
  organisationSlug: string;
  eventId: string;
  feedbackUrl: string;
  form: { isOpen: boolean; title: string; thankYouMessage: string; certificateEnabled: boolean; certificateTemplate?: unknown } | null;
  fields: Field[];
  /** Server-rendered responses summary (or a no-permission note) shown above the questions. */
  responses?: ReactNode;
  /** Used only for the small certificate preview. */
  eventTitle?: string;
  eventDateLabel?: string;
  organisationName?: string;
}) {
  const [isOpen, setIsOpen] = useState(props.form?.isOpen ?? false);
  const [title, setTitle] = useState(props.form?.title ?? "Event feedback");
  const [editingTitle, setEditingTitle] = useState(false);
  const [thankYouMessage, setThankYouMessage] = useState(props.form?.thankYouMessage ?? "Thanks for sharing your feedback.");
  const [certificateEnabled, setCertificateEnabled] = useState(props.form?.certificateEnabled ?? false);
  const [certificateTemplate, setCertificateTemplate] = useState(() => parseCertificateTemplate(props.form?.certificateTemplate));
  const [certificateBusy, setCertificateBusy] = useState(false);
  const [certificateDialog, setCertificateDialog] = useState(false);
  const [fields, setFields] = useState(props.fields);
  const [dialog, setDialog] = useState(false);
  const [editingField, setEditingField] = useState<Field | null>(null);
  const [templateDialog, setTemplateDialog] = useState(false);
  const [label, setLabel] = useState("");
  const [type, setType] = useState<RegistrationFieldType>("TEXTAREA");
  const [required, setRequired] = useState(false);
  const [options, setOptions] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [messageIsError, setMessageIsError] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [deleteField, setDeleteField] = useState<Field | null>(null);
  const [pending, startTransition] = useTransition();
  useUnsavedChangesGuard((dirty || certificateBusy) && !pending);

  const notify = (text: string, isError = false) => {
    setMessageIsError(isError);
    setMessage(text);
  };

  /**
   * Saves every form setting through the existing action. The two switches
   * call this straight away (with their new value); text and certificate
   * design changes wait for "Save changes".
   */
  const persist = (overrides: { isOpen?: boolean; certificateEnabled?: boolean }, successMessage: string, revert?: () => void) => startTransition(async () => {
    const result = await saveFeedbackSettings({
      organisationSlug: props.organisationSlug,
      eventId: props.eventId,
      isOpen: overrides.isOpen ?? isOpen,
      title,
      thankYouMessage,
      certificateEnabled: overrides.certificateEnabled ?? certificateEnabled,
      certificateTemplate,
    });
    if (result.ok) {
      setDirty(false);
      notify(successMessage);
    } else {
      revert?.();
      notify(result.error, true);
    }
  });

  const saveSettings = () => persist({}, "Feedback settings saved.");

  const toggleOpen = (next: boolean) => {
    setIsOpen(next);
    persist({ isOpen: next }, next ? "Feedback link opened." : "Feedback link closed.", () => setIsOpen(!next));
  };

  const toggleCertificate = (next: boolean) => {
    setCertificateEnabled(next);
    persist({ certificateEnabled: next }, next ? "Certificates turned on." : "Certificates turned off.", () => setCertificateEnabled(!next));
  };

  const openFieldDialog = (field?: Field) => {
    setEditingField(field ?? null);
    setLabel(field?.label ?? "");
    setType(field?.type ?? "TEXTAREA");
    setRequired(field?.required ?? false);
    setOptions(field?.options.join(", ") ?? "");
    setDialog(true);
  };

  const saveField = () => {
    const values = options.split(",").map((value) => value.trim()).filter(Boolean);
    const key = editingField?.key ?? (label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 64) || "feedback");
    startTransition(async () => {
      const result = await saveFeedbackField({ organisationSlug: props.organisationSlug, eventId: props.eventId, fieldId: editingField?.id, key, label, type, required, options: values });
      if (!result.ok) {
        notify(result.error, true);
        return;
      }
      const savedField = { id: result.data!.fieldId, key, label, type, required, options: values };
      setFields((current) => editingField
        ? current.map((field) => field.id === editingField.id ? savedField : field)
        : [...current, savedField]);
      setDialog(false);
      setEditingField(null);
      setLabel("");
      setOptions("");
      notify(editingField ? "Feedback question updated." : "Feedback question added.");
    });
  };

  const confirmDelete = () => {
    if (!deleteField) return;
    const target = deleteField;
    setDeleteField(null);
    startTransition(async () => {
      const result = await deleteFeedbackField({ organisationSlug: props.organisationSlug, eventId: props.eventId, fieldId: target.id });
      if (result.ok) {
        setFields((current) => current.filter((item) => item.id !== target.id));
        notify("Feedback question removed.");
      } else {
        notify(result.error, true);
      }
    });
  };

  const markDirty = () => setDirty(true);
  const applyTemplate = (template: FeedbackTemplate) => {
    startTransition(async () => {
      const result = await applyFeedbackTemplate({ organisationSlug: props.organisationSlug, eventId: props.eventId, templateId: template.id });
      if (!result.ok) {
        notify(result.error, true);
        return;
      }
      setFields(result.data!.fields);
      setTitle(template.title);
      setThankYouMessage(template.thankYouMessage);
      setIsOpen(false);
      setDirty(false);
      setTemplateDialog(false);
      notify(`${template.name} template applied. Review and customize it before opening the form.`);
    });
  };

  const copyLink = () => void navigator.clipboard.writeText(props.feedbackUrl).then(
    () => notify("Feedback link copied."),
    () => notify("Could not copy the feedback link.", true),
  );

  return (
    <div className="flex flex-col gap-5">
      <section aria-labelledby="feedback-form-title" className="flex flex-wrap items-center gap-4 rounded-xl bg-tint-peach px-4 py-4 sm:px-5">
        <MoodTile mood="love" size={52} className="yy-face shrink-0" />
        <div className="min-w-0 flex-[1_1_220px]">
          {editingTitle ? (
            <div className="flex flex-wrap items-end gap-2">
              <FormField label="Form title" className="min-w-0 flex-[1_1_200px]">
                <Input
                  value={title}
                  maxLength={120}
                  autoFocus
                  onChange={(event) => { setTitle(event.target.value); markDirty(); }}
                  onKeyDown={(event) => { if (event.key === "Enter" || event.key === "Escape") setEditingTitle(false); }}
                />
              </FormField>
              <Button variant="secondary" size="sm" className="mb-1" onClick={() => setEditingTitle(false)}>Done</Button>
            </div>
          ) : (
            <div className="flex items-center gap-1">
              <h2 id="feedback-form-title" className="min-w-0 text-h4 text-ink wrap-anywhere">“{title.trim() || "Event feedback"}”</h2>
              <IconButton label="Edit form title" size="sm" onClick={() => setEditingTitle(true)} disabled={pending}><Pencil /></IconButton>
            </div>
          )}
          <p className="text-body-ui text-ink-secondary">
            {isOpen
              ? "The feedback link is open. Share it after the event; Space Works Events never emails it on its own."
              : "The feedback link is closed. Open it when you’re ready; Space Works Events never emails it on its own."}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <span className="flex items-center gap-2">
            <Switch id="feedback-open" checked={isOpen} onCheckedChange={toggleOpen} disabled={pending || certificateBusy} />
            <label htmlFor="feedback-open" className="cursor-pointer text-label text-ink">
              <span className="sr-only">Feedback link </span>{isOpen ? "Open" : "Closed"}
            </label>
          </span>
          <Button variant="primary" startIcon={<Copy />} onClick={copyLink}>Copy feedback link</Button>
        </div>
      </section>

      {message ? <Callout tone={messageIsError ? "danger" : "info"} role={messageIsError ? "alert" : "status"} action={<Button size="sm" variant="quiet" onClick={() => setMessage(null)}>Dismiss</Button>}>{message}</Callout> : null}

      <div className="flex flex-wrap items-start gap-6">
        <div className="flex min-w-0 flex-[999_1_520px] flex-col gap-5">
          {props.responses}

          <section aria-labelledby="feedback-questions-title" className={card}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-1">
                <h2 id="feedback-questions-title" className="text-h4 text-ink">Questions</h2>
                <HelpLink article="after/feedback" />
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" size="sm" startIcon={<LayoutTemplate />} onClick={() => setTemplateDialog(true)} disabled={pending}>Use a template</Button>
                <Button variant="primary" size="sm" startIcon={<Plus />} onClick={() => openFieldDialog()} disabled={pending}>Add question</Button>
              </div>
            </div>
            {fields.length === 0 ? <EmptyState mood="sleepy">Add at least one question before opening the form.</EmptyState> : (
              <ul className="flex flex-col gap-2">
                {fields.map((field) => (
                  <li key={field.id} className="flex items-center gap-2 rounded-xl border border-line px-3.5 py-2.5">
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold text-ink wrap-anywhere">{field.label}</p>
                      <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-caption text-ink-muted">
                        <Chip size="sm">{questionTypeLabel(field)}</Chip>
                        {field.required ? <span>Required</span> : <span>Optional</span>}
                        {field.options.length && !questionTypeLabel(field).startsWith("Rating") ? <span className="min-w-0 truncate">· {field.options.join(", ")}</span> : null}
                      </p>
                    </div>
                    <Button size="sm" variant="quiet" aria-label={`Edit ${field.label}`} disabled={pending} onClick={() => openFieldDialog(field)}>Edit</Button>
                    <IconButton label={`Delete ${field.label}`} size="sm" variant="danger" disabled={pending} onClick={() => setDeleteField(field)}><Trash2 /></IconButton>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <aside aria-label="Certificate and thank-you settings" className="flex min-w-0 flex-[1_1_300px] flex-col gap-5">
          <section aria-labelledby="feedback-certificate-title" className={card}>
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-1">
                <h2 id="feedback-certificate-title" className="text-h4 text-ink">Certificate</h2>
                <HelpLink article="after/certificates" />
              </div>
              <Switch aria-label="Offer certificates" checked={certificateEnabled} onCheckedChange={toggleCertificate} disabled={pending || certificateBusy} />
            </div>
            <CertificatePreview template={certificateTemplate} eventTitle={props.eventTitle} eventDateLabel={props.eventDateLabel} organisationName={props.organisationName} muted={!certificateEnabled} />
            <p className="text-caption text-ink-muted">
              {certificateEnabled
                ? "A JPEG certificate is offered after someone submits feedback. Upload your own artwork and place the name."
                : "Turn on to offer a JPEG certificate after someone submits feedback."}
            </p>
            <Button variant="secondary" size="sm" className="self-start" startIcon={<Award />} disabled={!certificateEnabled || pending} onClick={() => setCertificateDialog(true)}>Design certificate</Button>
          </section>

          <section aria-labelledby="feedback-after-title" className={card}>
            <h2 id="feedback-after-title" className="text-h4 text-ink">After they submit</h2>
            <FormField label="Thank-you message">
              <Input value={thankYouMessage} maxLength={500} onChange={(event) => { setThankYouMessage(event.target.value); markDirty(); }} />
            </FormField>
          </section>
        </aside>
      </div>

      {dirty || certificateBusy ? (
        <div role="status" className="sticky bottom-4 z-10 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-inverse px-4 py-3 text-on-inverse shadow-float">
          <span className="text-label">{certificateBusy ? "Working on the certificate…" : "You have unsaved changes"}</span>
          <Button variant="inverse" size="sm" onClick={saveSettings} disabled={pending || certificateBusy || !dirty}>{pending ? "Saving…" : "Save changes"}</Button>
        </div>
      ) : null}

      <Dialog open={certificateDialog} onOpenChange={(next) => { if (!next && !certificateBusy) setCertificateDialog(false); }}>
        <DialogContent size="xl">
          <DialogHeader title="Design certificate" description="Changes apply once you save them." />
          <DialogBody>
            <CertificateBuilder organisationSlug={props.organisationSlug} eventId={props.eventId} value={certificateTemplate} onChange={(value) => { setCertificateTemplate(value); markDirty(); }} disabled={pending} onBusyChange={setCertificateBusy} eventTitle={props.eventTitle} eventDateLabel={props.eventDateLabel} organisationName={props.organisationName} />
          </DialogBody>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setCertificateDialog(false)} disabled={certificateBusy}>Done</Button>
            <Button variant="primary" onClick={saveSettings} disabled={pending || certificateBusy || !dirty}>{pending ? "Saving…" : "Save changes"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <QuestionDialog
        dialog={dialog}
        setDialog={setDialog}
        pending={pending}
        editingField={editingField}
        label={label}
        setLabel={setLabel}
        type={type}
        setType={setType}
        options={options}
        setOptions={setOptions}
        required={required}
        setRequired={setRequired}
        saveField={saveField}
      />
      <TemplateDialog templateDialog={templateDialog} setTemplateDialog={setTemplateDialog} pending={pending} applyTemplate={applyTemplate} />
      <ConfirmationDialog
        open={Boolean(deleteField)}
        title="Delete feedback question?"
        message={`Delete “${deleteField?.label ?? "this question"}”? Existing answers may prevent removal.`}
        confirmLabel="Delete question"
        loading={pending}
        onCancel={() => setDeleteField(null)}
        onConfirm={confirmDelete}
      />
    </div>
  );
}
