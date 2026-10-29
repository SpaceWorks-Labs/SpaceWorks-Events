"use client";

import { useRef, useState, useTransition } from "react";
import { Pencil } from "lucide-react";
import { RegistrationQuestions, focusQuestion, useRegistrationAnswers } from "@/components/rsvp/QuestionField";
import { identityErrors } from "@/components/rsvp/registrationAnswers";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/display";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/field";
import { updateRsvpRegistration } from "@/app/actions/rsvp-admin";
import type { AttendeeRow } from "@/components/attendees/types";
import type { ManualRsvpField } from "@/components/attendees/ManualRsvpDialog";
import { useToast } from "@/components/feedback/ToastProvider";

function initialAnswers(attendee: AttendeeRow, fields: ManualRsvpField[]) {
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const values = (attendee.rawAnswers ?? []).filter(
      (answer) => answer.fieldId === field.id,
    );
    const answer = values[0];
    if (field.type === "MULTI_SELECT")
      result[field.key] = values
        .map((value) => value.valueText)
        .filter((value): value is string => Boolean(value));
    else if (field.type === "CHECKBOX")
      result[field.key] = answer?.valueBool ?? false;
    else if (field.type === "NUMBER")
      result[field.key] = answer?.valueNumber ?? "";
    else if (field.type === "DATE")
      result[field.key] = answer?.valueDate
        ? answer.valueDate.slice(0, 10)
        : "";
    else result[field.key] = answer?.valueText ?? "";
  }
  return result;
}

export function EditRsvpDialog(props: {
  organisationSlug: string;
  eventId?: string;
  eventInstanceId?: string;
  attendee: AttendeeRow;
  fields: ManualRsvpField[];
  onClose: () => void;
  onUpdated: () => void;
}) {
  const {
    attendee,
    fields,
    organisationSlug,
    eventId,
    eventInstanceId,
    onClose,
    onUpdated,
  } = props;
  const { showToast } = useToast();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState(attendee.guestName ?? "");
  const [email, setEmail] = useState(attendee.guestEmail ?? "");
  const [identity, setIdentity] = useState<{ name?: string; email?: string }>({});
  // Saved answers, including "Other" text and answers to questions now hidden by logic
  // (those are dropped on save, matching the server).
  const questions = useRegistrationAnswers(fields, initialAnswers(attendee, fields));
  const formRef = useRef<HTMLFormElement>(null);

  const canTransfer = !attendee.user;
  return (
    <Dialog open onOpenChange={(next) => { if (!next && !pending) onClose(); }}>
      <DialogContent size="md">
      <form
        ref={formRef}
        noValidate
        className="flex min-h-0 flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          setError(null);
          const who = attendee.user ? {} : identityErrors({ name, email, requireName: true, requireEmail: true });
          const questionErrors = questions.validate();
          setIdentity(who);
          const first = who.name ? "__name" : who.email ? "__email" : fields.find((field) => questionErrors[field.key])?.key;
          if (first) {
            focusQuestion(formRef.current, first);
            return;
          }
          startTransition(async () => {
            const result = await updateRsvpRegistration({
              organisationSlug,
              eventId,
              eventInstanceId,
              rsvpId: attendee.id,
              ...(attendee.user ? {} : { name, guestEmail: email }),
              answers: questions.payload(),
            });
            if (!result.ok) {
              setError(result.error);
              return;
            }
            showToast(
              canTransfer ? "Ticket transferred" : "Registration updated",
              "success",
            );
            onUpdated();
            onClose();
          });
        }}
      >
        <DialogHeader
          title={canTransfer ? "Edit registration or transfer ticket" : "View registration"}
          description={canTransfer
            ? "Change the guest name and email to transfer this ticket. A new email gets a new ticket link, and the previous holder's ticket, attendance and project links stop working. The RSVP status and check-in state stay unchanged."
            : "Signed-in attendee ownership cannot be transferred. Their ticket and check-in status remain unchanged."}
        />
        <DialogBody className="flex flex-col gap-4">
          {error ? <Callout tone="danger" role="alert">{error}</Callout> : null}
          {attendee.user ? (
            <div className="rounded-md bg-subtle px-3 py-2.5 text-body-ui">
              <p className="font-semibold text-ink">{attendee.user.name ?? "Signed-in attendee"}</p>
              <p className="text-ink-muted">{attendee.user.email ?? "No email"}</p>
            </div>
          ) : (
            <>
              <div data-question-key="__name">
                <Field label="Name" required error={identity.name}>
                  <Input value={name} onChange={(event) => { setName(event.target.value); setIdentity((current) => ({ ...current, name: undefined })); }} autoFocus />
                </Field>
              </div>
              <div data-question-key="__email">
                <Field label="Email" required error={identity.email}>
                  <Input type="email" value={email} onChange={(event) => { setEmail(event.target.value); setIdentity((current) => ({ ...current, email: undefined })); }} />
                </Field>
              </div>
            </>
          )}
          <RegistrationQuestions controller={questions} className="gap-4" />
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose} disabled={pending}>Cancel</Button>
          <Button type="submit" variant="primary" startIcon={<Pencil />} loading={pending}>
            {canTransfer ? "Save transfer" : "Save changes"}
          </Button>
        </DialogFooter>
      </form>
      </DialogContent>
    </Dialog>
  );
}
