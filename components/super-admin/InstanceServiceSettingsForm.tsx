"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { CheckboxField } from "@/components/ui/choice";
import { Callout, Card, SettingsRow } from "@/components/ui/display";
import { Field, Input, PasswordInput } from "@/components/ui/field";
import { saveInstanceServiceSettings, sendSettingsTestEmail } from "@/app/actions/instance-settings";
import { backupInputToIso } from "@/lib/backupTime";

type Values = { emailFrom: string; smtpService: string; smtpHost: string; smtpPort: string; smtpSecure: boolean; smtpUser: string; smtpAllowUnauthenticated: boolean; googleClientId: string; googleMobileClientIds: string; backupProvider: string; backupLastSuccessAt: string; backupRetentionDays: string; hasSmtpPassword: boolean; hasGoogleClientSecret: boolean };
type TextKey = { [K in keyof Values]: Values[K] extends string ? K : never }[keyof Values];
type Status = { tone: "success" | "danger"; text: string } | null;

/** Where effective values come from when they are not saved here. Never secrets. */
export type InstanceServiceSettingsFallback = {
  smtpNote: string;
  emailFromNote?: string;
  googleNote: string;
  backupNote?: string;
  /** Saved but not decryptable with this replica's MFA_ENCRYPTION_KEY. */
  smtpPasswordUnreadable?: boolean;
  googleSecretUnreadable?: boolean;
  placeholders: Partial<Record<TextKey, string | undefined>>;
};

export function InstanceServiceSettingsForm({ initial, fallback }: { initial: Values; fallback: InstanceServiceSettingsFallback }) {
  const [values, setValues] = useState(initial);
  const [unreadable, setUnreadable] = useState({ smtp: Boolean(fallback.smtpPasswordUnreadable), google: Boolean(fallback.googleSecretUnreadable) });
  const [smtpPassword, setSmtpPassword] = useState("");
  const [googleClientSecret, setGoogleClientSecret] = useState("");
  const [status, setStatus] = useState<Status>(null);
  const [pending, startTransition] = useTransition();
  const [testing, startTest] = useTransition();
  const set = (key: keyof Values, value: string | boolean) => setValues((current) => ({ ...current, [key]: value }));
  function submit() {
    startTransition(async () => {
      setStatus(null);
      const result = await saveInstanceServiceSettings({
        emailFrom: values.emailFrom, smtpService: values.smtpService, smtpHost: values.smtpHost,
        smtpPort: values.smtpPort || undefined, smtpSecure: values.smtpSecure, smtpUser: values.smtpUser,
        smtpAllowUnauthenticated: values.smtpAllowUnauthenticated, googleClientId: values.googleClientId, googleMobileClientIds: values.googleMobileClientIds,
        backupProvider: values.backupProvider, backupLastSuccessAt: backupInputToIso(values.backupLastSuccessAt),
        backupRetentionDays: values.backupRetentionDays || undefined,
        smtpPassword: smtpPassword || undefined, googleClientSecret: googleClientSecret || undefined,
      });
      if (result.ok) {
        // Mirror how the server keeps or clears the write-only secrets.
        const smtpKept = Boolean((values.smtpService || values.smtpHost) && values.smtpUser);
        setValues((current) => ({
          ...current,
          hasSmtpPassword: smtpKept && (current.hasSmtpPassword || Boolean(smtpPassword)),
          hasGoogleClientSecret: Boolean(current.googleClientId) && (current.hasGoogleClientSecret || Boolean(googleClientSecret)),
        }));
        setUnreadable((current) => ({ smtp: current.smtp && !smtpPassword, google: current.google && !googleClientSecret }));
        setSmtpPassword("");
        setGoogleClientSecret("");
      }
      setStatus(result.ok ? { tone: "success", text: "Settings saved." } : { tone: "danger", text: result.error ?? "Could not save settings." });
    });
  }
  function sendTest() {
    startTest(async () => {
      setStatus(null);
      const result = await sendSettingsTestEmail();
      setStatus(result.ok ? { tone: "success", text: "Test email sent to your super-admin address. Check your inbox." } : { tone: "danger", text: result.error ?? "The test email could not be sent." });
    });
  }
  const field = (key: TextKey, label: string, type = "text", helperText?: string) => (
    <Field label={label} helperText={helperText}>
      <Input type={type} value={values[key]} placeholder={fallback.placeholders[key]} onChange={(event) => set(key, event.target.value)} />
    </Field>
  );

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      className="flex flex-col gap-5"
    >
      {status ? <Callout tone={status.tone} role={status.tone === "success" ? "status" : "alert"}>{status.text}</Callout> : null}
      <Card padding="none" className="rounded-xl px-5">
        <SettingsRow title="SMTP" description={fallback.smtpNote}>
          <div className="flex flex-col gap-4">
            {field("emailFrom", "Sender address", "text", fallback.emailFromNote ?? "An address, or Name <address>.")}
            {field("smtpService", "Service (optional)", "text", "A Nodemailer service name such as gmail. Leave empty when using a host.")}
            {field("smtpHost", "Host (optional)", "text", "Leave empty when using a service.")}
            <div className="grid gap-4 sm:grid-cols-2">
              {field("smtpPort", "Port", "number")}
              {field("smtpUser", "Username")}
            </div>
            <Field
              label={values.hasSmtpPassword ? "Password (leave blank to keep current)" : "Password"}
              error={values.hasSmtpPassword && unreadable.smtp ? "Saved but unreadable with this instance's MFA_ENCRYPTION_KEY. Re-enter the password." : undefined}
            >
              <PasswordInput value={smtpPassword} onChange={(event) => setSmtpPassword(event.target.value)} autoComplete="new-password" />
            </Field>
            <CheckboxField label="Use implicit TLS" checked={values.smtpSecure} onCheckedChange={(checked) => set("smtpSecure", checked === true)} />
            <CheckboxField label="Private unauthenticated relay" checked={values.smtpAllowUnauthenticated} onCheckedChange={(checked) => set("smtpAllowUnauthenticated", checked === true)} />
          </div>
        </SettingsRow>
        <SettingsRow title="Google SSO" description={`Register the callback URL shown in the deployment documentation with Google. ${fallback.googleNote}`}>
          <div className="flex flex-col gap-4">
            {field("googleClientId", "OAuth client ID")}
            {field("googleMobileClientIds", "Mobile app client IDs", "text", "The Android and iOS OAuth client IDs of the Space Works app, separated by commas. Not secret.")}
            <Field
              label={values.hasGoogleClientSecret ? "OAuth client secret (leave blank to keep current)" : "OAuth client secret"}
              error={values.hasGoogleClientSecret && unreadable.google ? "Saved but unreadable with this instance's MFA_ENCRYPTION_KEY. Re-enter the secret." : undefined}
            >
              <PasswordInput value={googleClientSecret} onChange={(event) => setGoogleClientSecret(event.target.value)} autoComplete="new-password" />
            </Field>
          </div>
        </SettingsRow>
        <SettingsRow title="Backup configuration" description={`This records backup posture only; backup creation and restore access remain with the database provider.${fallback.backupNote ? ` ${fallback.backupNote}` : ""}`}>
          <div className="flex flex-col gap-4">
            {field("backupProvider", "Provider")}
            {field("backupLastSuccessAt", "Last successful backup (UTC)", "datetime-local")}
            {field("backupRetentionDays", "Retention days", "number")}
          </div>
        </SettingsRow>
      </Card>
      <div className="flex flex-wrap gap-3">
        <Button type="submit" variant="primary" loading={pending}>Save instance settings</Button>
        <Button type="button" onClick={sendTest} loading={testing} disabled={pending}>Send test email</Button>
      </div>
      <p className="text-caption text-ink-muted">The test email uses the saved settings and goes to your super-admin address. Save changes first.</p>
    </form>
  );
}
