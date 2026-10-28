import { requireSuperAdminMfa } from "@/lib/permissions";
import { prisma } from "@/lib/db";
import { getEmailSettingsStatus, getGoogleSsoStatus, getMobileGoogleClientIdsFromEnv, INSTANCE_SETTINGS_ID, resolveBackupPosture } from "@/lib/instanceSettings";
import { decryptInstanceConfigSecret } from "@/lib/instanceConfigSecrets";
import type { InstanceServiceSettingsFallback } from "@/components/super-admin/InstanceServiceSettingsForm";

/** Only the host of the write-only webhook URL is shown; its path is the credential. */
function webhookHost(encrypted: string | null | undefined) {
  if (!encrypted) return null;
  try {
    return new URL(decryptInstanceConfigSecret(encrypted)).host;
  } catch {
    return "a saved webhook (unreadable; enter it again)";
  }
}

/** `datetime-local` value in UTC; the form labels and submits it as UTC. */
function utcInputValue(value: Date | null | undefined) {
  return value ? value.toISOString().slice(0, 16) : "";
}

export async function loadSuperAdminSettingsView() {
  await requireSuperAdminMfa();
  const [settings, email, google] = await Promise.all([
    prisma.instanceSetting.findUnique({ where: { id: INSTANCE_SETTINGS_ID } }),
    getEmailSettingsStatus(),
    getGoogleSsoStatus(),
  ]);
  const backup = resolveBackupPosture(settings);

  // The form holds saved values only; environment fallbacks are shown as
  // placeholders and notes so saving never copies them into the database.
  const fallback: InstanceServiceSettingsFallback = {
    smtpNote: email.source === "database"
      ? "Using the SMTP settings saved here; SMTP_* environment values are ignored. Clear both Service and Host to fall back to the environment."
      : email.source === "environment"
        ? `Not saved here. Email currently uses the environment configuration (${email.service ? `service ${email.service}` : `host ${email.host}:${email.port}`}${email.secure ? ", implicit TLS" : ""}, ${email.user ? "username set" : "no username"}, ${email.hasPassword ? "password set" : "no password"}). Saving a service or host here replaces it entirely.`
        : "Email delivery is not configured. Enter a service or a host.",
    emailFromNote: email.fromSource === "database" ? undefined
      : email.fromSource === "environment" ? `Not saved here; using EMAIL_FROM from the environment: ${email.from}`
        : `Not saved here; using the default: ${email.from}`,
    googleNote: google.source === "database"
      ? google.hasSecret ? "Using the Google client saved here; environment values are ignored. Clear the client ID to turn Google sign-in off or fall back to the environment."
        : "The saved client ID has no secret, so Google sign-in is off until you enter one."
      : google.source === "environment"
        ? `Not saved here. Google sign-in uses the environment client ${google.clientId}${google.hasSecret ? "" : " (secret missing, so sign-in is off)"}. Saving a client ID here replaces it.`
        : "Google sign-in is off.",
    backupNote: backup.source === "environment"
      ? "Not saved here; Operations shows the BACKUP_* environment values (shown as placeholders). Saving any backup value here replaces them."
      : undefined,
    smtpPasswordUnreadable: email.source === "database" && email.passwordUnreadable,
    googleSecretUnreadable: google.secretUnreadable,
    placeholders: {
      emailFrom: email.fromSource === "database" ? undefined : email.from,
      ...(email.source === "environment" ? {
        smtpService: email.service, smtpHost: email.host,
        smtpPort: email.service ? undefined : String(email.port), smtpUser: email.user,
      } : {}),
      ...(google.source === "environment" ? { googleClientId: google.clientId } : {}),
      ...(settings?.googleMobileClientIds ? {} : { googleMobileClientIds: getMobileGoogleClientIdsFromEnv().join(", ") || undefined }),
      ...(backup.source === "environment" ? {
        backupProvider: backup.provider,
        backupRetentionDays: backup.retentionDays ? String(backup.retentionDays) : undefined,
      } : {}),
    },
  };

  return {
    fallback,
    initial: {
      emailFrom: settings?.emailFrom ?? "",
      smtpService: settings?.smtpService ?? "",
      smtpHost: settings?.smtpHost ?? "",
      smtpPort: settings?.smtpPort ? String(settings.smtpPort) : "",
      smtpSecure: settings?.smtpSecure ?? false,
      smtpUser: settings?.smtpUser ?? "",
      smtpAllowUnauthenticated: settings?.smtpAllowUnauthenticated ?? false,
      googleClientId: settings?.googleClientId ?? "",
      googleMobileClientIds: settings?.googleMobileClientIds ?? "",
      backupProvider: settings?.backupProvider ?? "",
      backupLastSuccessAt: utcInputValue(settings?.backupLastSuccessAt),
      backupRetentionDays: settings?.backupRetentionDays ? String(settings.backupRetentionDays) : "",
      hasSmtpPassword: Boolean(settings?.smtpPasswordEncrypted),
      hasGoogleClientSecret: Boolean(settings?.googleClientSecretEncrypted),
    },
    paidEventsEnabled: settings?.paidEventsEnabled ?? false,
    opsWebhook: { enabled: settings?.opsWebhookEnabled ?? false, includeWarnings: settings?.opsWebhookIncludeWarnings ?? true, configuredHost: webhookHost(settings?.opsWebhookUrlEncrypted) },
  };
}
