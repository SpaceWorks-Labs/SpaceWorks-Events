"use client";

import type { Dispatch, SetStateAction } from "react";
import { Field, Input } from "@/components/ui/field";
import { identityErrors } from "@/components/rsvp/registrationAnswers";

type Identity = { name?: string; email?: string };

/** The optional (or required) name for a signed-in registrant, defaulting to their account name. */
export function SignedInNameField({ name, setName, identity, setIdentity, requireName, accountName }: {
  name: string;
  setName: Dispatch<SetStateAction<string>>;
  identity: Identity;
  setIdentity: Dispatch<SetStateAction<Identity>>;
  requireName: boolean;
  accountName: string | null | undefined;
}) {
  return (
    <div data-question-key="__name">
      <Field label="Name" optional={!requireName} required={requireName} error={identity.name} helperText={!requireName ? `Leave blank to use ${accountName}.` : undefined}>
        <Input
          name="name"
          autoComplete="name"
          value={name}
          placeholder={accountName ?? ""}
          onChange={(event) => {
            setName(event.target.value);
            if (identity.name && event.target.value.trim()) setIdentity((current) => ({ ...current, name: undefined }));
          }}
          maxLength={200}
        />
      </Field>
    </div>
  );
}

/** A guest's name and email, each re-checked as it is corrected. */
export function GuestIdentityFields({ name, setName, guestEmail, setGuestEmail, identity, setIdentity }: {
  name: string;
  setName: Dispatch<SetStateAction<string>>;
  guestEmail: string;
  setGuestEmail: Dispatch<SetStateAction<string>>;
  identity: Identity;
  setIdentity: Dispatch<SetStateAction<Identity>>;
}) {
  return (
    <>
    <div data-question-key="__name">
      <Field label="Name" required error={identity.name}>
        <Input
          name="name"
          autoComplete="name"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            if (identity.name && event.target.value.trim()) setIdentity((current) => ({ ...current, name: undefined }));
          }}
          maxLength={200}
        />
      </Field>
    </div>
    <div data-question-key="__email">
      <Field label="Email" required error={identity.email} helperText="We’ll send your ticket here.">
        <Input
          name="guestEmail"
          type="email"
          autoComplete="email"
          value={guestEmail}
          onChange={(event) => {
            setGuestEmail(event.target.value);
            if (identity.email) {
              const recheck = identityErrors({ name, email: event.target.value, requireName: false, requireEmail: true }).email;
              setIdentity((current) => ({ ...current, email: recheck }));
            }
          }}
        />
      </Field>
    </div>
    </>
  );
}
