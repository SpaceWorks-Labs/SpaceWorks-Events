"use server";

import { z } from "zod";
import { revalidatePath as nextRevalidatePath } from "next/cache";
import { trackedRevalidation } from "@/lib/frontend/revalidation";
import { prisma } from "@/lib/db";
import { INSTANCE_SETTINGS_ID, isGoogleClientIdList, isValidSenderAddress, parseGoogleClientIdList } from "@/lib/instanceSettings";
import { assertEmailAccepted, EmailRecipientRejectedError, EmailTransportUnavailableError, getPlatformTransport } from "@/lib/email/transporter";
import { describeOperationalError } from "@/lib/redactSensitiveText";
import { requireSuperAdminMfa } from "@/lib/permissions";
import { recordAuditEvent } from "@/lib/audit";
import { decryptInstanceConfigSecret, encryptInstanceConfigSecret, InstanceSecretUnreadableError } from "@/lib/instanceConfigSecrets";
import { invalidateOpsAlertSettings, parseOpsWebhookUrl, reportOpsAlert, sendOpsWebhookTestMessage } from "@/lib/opsAlerts";
import { isAllowedOpsWebhook, PRIVATE_WEBHOOK_ERROR } from "@/lib/opsWebhookAddress";
import { isActionRateLimited } from "@/lib/actionRateLimit";
import type { ActionResult } from "./org";

const revalidatePath = trackedRevalidation(nextRevalidatePath);

const signupSettingSchema = z.object({ allowNewUserSignups: z.boolean() });
const paidEventsSettingSchema = z.object({ paidEventsEnabled: z.boolean() }).strict();

const optionalText = (max: number) => z.string().trim().max(max).optional().transform((value) => value || undefined);
const optionalNumber = (min: number, max: number) => z.preprocess(
  (value) => (value === "" || value === null ? undefined : value),
  z.coerce.number().int().min(min).max(max).optional(),
);

const serviceSettingsSchema = z.object({
  emailFrom: optionalText(320).refine((value) => !value || isValidSenderAddress(value), "Enter the sender as an email address or as Name <address>."),
  smtpService: optionalText(120), smtpHost: optionalText(253),
  smtpPort: optionalNumber(1, 65535), smtpSecure: z.boolean(),
  smtpUser: optionalText(320), smtpPassword: z.string().max(1024).optional(), smtpAllowUnauthenticated: z.boolean(),
  googleClientId: optionalText(320), googleClientSecret: z.string().max(1024).optional(),
  googleMobileClientIds: optionalText(2000).refine((value) => !value || isGoogleClientIdList(value), "Enter Google OAuth client IDs separated by commas."),
  backupProvider: optionalText(80),
  backupLastSuccessAt: z.preprocess((value) => (value === "" || value === null ? undefined : value), z.string().datetime().optional()),
  backupRetentionDays: optionalNumber(1, 3650),
}).superRefine((value, ctx) => {
  if (value.smtpService && value.smtpHost) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["smtpHost"], message: "Choose either an SMTP service or a host, not both." });
  if (value.smtpHost && /[\s/@]/.test(value.smtpHost)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["smtpHost"], message: "Enter the SMTP host name only, without a scheme, path, or credentials." });
  if ((value.smtpService || value.smtpHost) && !value.smtpAllowUnauthenticated && !value.smtpUser) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["smtpUser"], message: "SMTP credentials are required unless using a private relay." });
  if (value.googleClientSecret && !value.googleClientId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["googleClientId"], message: "Enter the Google OAuth client ID for this secret." });
});

export async function setNewUserRegistrationEnabled(input: unknown): Promise<ActionResult> {
  const session = await requireSuperAdminMfa();
  if (await isActionRateLimited("action", session.user.id)) return { ok: false, error: "Too many requests. Try again shortly." };
  const parsed = signupSettingSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid account creation setting." };

  await prisma.instanceSetting.upsert({
    where: { id: INSTANCE_SETTINGS_ID },
    create: { id: INSTANCE_SETTINGS_ID, allowNewUserSignups: parsed.data.allowNewUserSignups },
    update: { allowNewUserSignups: parsed.data.allowNewUserSignups },
  });
  await recordAuditEvent({
    action: "NEW_USER_REGISTRATION_SETTING_UPDATED",
    actorUserId: session.user.id,
    targetType: "InstanceSetting",
    targetId: INSTANCE_SETTINGS_ID,
    metadata: { allowNewUserSignups: parsed.data.allowNewUserSignups },
  });
  revalidatePath("/login");
  revalidatePath("/super-admin/auth");
  return { ok: true };
}

/** Off by default. Turning it off stops new paid tickets; existing payments still settle and refund. */
export async function setPaidEventsEnabled(input: unknown): Promise<ActionResult> {
  const session = await requireSuperAdminMfa();
  if (await isActionRateLimited("action", session.user.id)) return { ok: false, error: "Too many requests. Try again shortly." };
  const parsed = paidEventsSettingSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid paid events setting." };

  await prisma.instanceSetting.upsert({
    where: { id: INSTANCE_SETTINGS_ID },
    create: { id: INSTANCE_SETTINGS_ID, paidEventsEnabled: parsed.data.paidEventsEnabled },
    update: { paidEventsEnabled: parsed.data.paidEventsEnabled },
  });
  await recordAuditEvent({
    action: "PAID_EVENTS_SETTING_UPDATED",
    actorUserId: session.user.id,
    targetType: "InstanceSetting",
    targetId: INSTANCE_SETTINGS_ID,
    metadata: { paidEventsEnabled: parsed.data.paidEventsEnabled },
  });
  revalidatePath("/super-admin/settings");
  return { ok: true };
}

export async function saveInstanceServiceSettings(input: unknown): Promise<ActionResult> {
  const session = await requireSuperAdminMfa();
  if (await isActionRateLimited("action", session.user.id)) return { ok: false, error: "Too many requests. Try again shortly." };
  const parsed = serviceSettingsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid instance settings." };
  const value = parsed.data;
  const smtpPassword = value.smtpPassword || undefined;
  const googleClientSecret = value.googleClientSecret || undefined;
  const existing = await prisma.instanceSetting.findUnique({
    where: { id: INSTANCE_SETTINGS_ID },
    select: { smtpPasswordEncrypted: true, googleClientSecretEncrypted: true },
  });

  // Saved SMTP replaces the environment as a whole (see getEmailSettings), so
  // the stored fields are always written together. With neither a service nor
  // a host, every SMTP field is cleared and the environment fallback applies.
  const smtpConfigured = Boolean(value.smtpService || value.smtpHost);
  const keepsPassword = smtpConfigured && Boolean(value.smtpUser);
  if (smtpConfigured && !value.smtpAllowUnauthenticated && !smtpPassword && !existing?.smtpPasswordEncrypted) {
    return { ok: false, error: "Enter an SMTP password or use a deliberately unauthenticated private relay." };
  }
  if (value.googleClientId && !googleClientSecret && !existing?.googleClientSecretEncrypted) {
    return { ok: false, error: "Enter the Google OAuth client secret." };
  }

  const smtpData = smtpConfigured
    ? {
        smtpService: value.smtpService ?? null,
        smtpHost: value.smtpService ? null : value.smtpHost ?? null,
        smtpPort: value.smtpService ? null : value.smtpPort ?? null,
        smtpSecure: value.smtpSecure,
        smtpUser: value.smtpUser ?? null,
        smtpAllowUnauthenticated: value.smtpAllowUnauthenticated,
      }
    : { smtpService: null, smtpHost: null, smtpPort: null, smtpSecure: false, smtpUser: null, smtpAllowUnauthenticated: false };
  const smtpPasswordUpdate = !keepsPassword
    ? { smtpPasswordEncrypted: null }
    : smtpPassword ? { smtpPasswordEncrypted: encryptInstanceConfigSecret(smtpPassword) } : {};
  // Clearing the client ID also drops its secret, so sign-in stops offering Google.
  const googleSecretUpdate = !value.googleClientId
    ? { googleClientSecretEncrypted: null }
    : googleClientSecret ? { googleClientSecretEncrypted: encryptInstanceConfigSecret(googleClientSecret) } : {};
  const data = {
    emailFrom: value.emailFrom ?? null,
    ...smtpData,
    googleClientId: value.googleClientId ?? null,
    googleMobileClientIds: value.googleMobileClientIds ? parseGoogleClientIdList(value.googleMobileClientIds).join(",") : null,
    backupProvider: value.backupProvider ?? null,
    backupLastSuccessAt: value.backupLastSuccessAt ? new Date(value.backupLastSuccessAt) : null,
    backupRetentionDays: value.backupRetentionDays ?? null,
  };
  await prisma.instanceSetting.upsert({
    where: { id: INSTANCE_SETTINGS_ID },
    create: { id: INSTANCE_SETTINGS_ID, ...data, smtpPasswordEncrypted: null, googleClientSecretEncrypted: null, ...smtpPasswordUpdate, ...googleSecretUpdate },
    update: { ...data, ...smtpPasswordUpdate, ...googleSecretUpdate },
  });
  await recordAuditEvent({
    action: "INSTANCE_SERVICE_SETTINGS_UPDATED", actorUserId: session.user.id, targetType: "InstanceSetting", targetId: INSTANCE_SETTINGS_ID,
    metadata: {
      smtpConfigured, smtpPasswordChanged: Boolean(smtpPassword) && keepsPassword,
      googleSsoConfigured: Boolean(value.googleClientId), googleSecretChanged: Boolean(googleClientSecret), googleMobileClients: Boolean(value.googleMobileClientIds),
      backupConfigured: Boolean(value.backupProvider),
    },
  });
  revalidatePath("/login");
  revalidatePath("/super-admin/settings");
  revalidatePath("/super-admin/operations");
  return { ok: true };
}

const TEST_EMAIL_TIMEOUT_MS = 15_000;

class TestEmailTimeoutError extends Error {
  override name = "TimeoutError";
  code = "ETIMEDOUT";
}

function testEmailFailureMessage(error: unknown) {
  if (error instanceof EmailTransportUnavailableError) return "Email delivery is not configured. Save SMTP settings (with credentials) first.";
  if (error instanceof InstanceSecretUnreadableError) return error.message;
  const detail = describeOperationalError(error);
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  const hint = code === "EAUTH" ? "The SMTP server rejected the username or password."
    : code === "ETIMEDOUT" ? `The SMTP server did not respond within ${TEST_EMAIL_TIMEOUT_MS / 1000} seconds.`
    : ["ECONNECTION", "ECONNREFUSED", "ESOCKET", "EDNS", "ENOTFOUND", "EHOSTUNREACH"].includes(code) ? "Could not connect to the SMTP server. Check the host, port, and TLS setting."
    : code === "ETLS" ? "The TLS connection to the SMTP server failed."
    : error instanceof EmailRecipientRejectedError || code === "EENVELOPE" ? "The SMTP server refused the sender or recipient."
    : "The SMTP server did not accept the message.";
  return `${hint} (${detail})`;
}

/**
 * Send a short test email to the signed-in super-admin using the saved,
 * effective settings. This is an operator action, so it waits for SMTP, capped
 * at 15 seconds. Errors are reduced to a name and code; addresses never leave.
 */
export async function sendSettingsTestEmail(): Promise<ActionResult> {
  const session = await requireSuperAdminMfa();
  if (await isActionRateLimited("action", session.user.id)) return { ok: false, error: "Too many requests. Try again shortly." };
  let source = "none";
  let transporter: Awaited<ReturnType<typeof getPlatformTransport>>["transporter"] = null;
  let failure: unknown = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const transport = await getPlatformTransport({ timeoutMs: TEST_EMAIL_TIMEOUT_MS });
    source = transport.source;
    transporter = transport.transporter;
    if (!transporter) throw new EmailTransportUnavailableError();
    const send = transporter.sendMail({
      from: transport.from,
      to: session.user.email,
      subject: "Space Works Events test email",
      text: "This is a test email from Super-admin > Settings. Email delivery for this Space Works Events installation is working.",
    });
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new TestEmailTimeoutError("SMTP test timed out")), TEST_EMAIL_TIMEOUT_MS);
    });
    send.catch(() => undefined);
    assertEmailAccepted(await Promise.race([send, timeout]));
  } catch (error) {
    failure = error;
  } finally {
    if (timer) clearTimeout(timer);
    transporter?.close();
  }
  const errorSummary = failure ? describeOperationalError(failure) : null;
  await recordAuditEvent({
    action: "INSTANCE_TEST_EMAIL_SENT", actorUserId: session.user.id, targetType: "InstanceSetting", targetId: INSTANCE_SETTINGS_ID,
    metadata: { delivered: !failure, source, error: errorSummary },
  });
  if (!failure) return { ok: true };
  reportOpsAlert({ level: "warning", source: "email", title: "Super-admin test email failed", context: { error: errorSummary, configSource: source } });
  return { ok: false, error: testEmailFailureMessage(failure) };
}

const opsWebhookSettingsSchema = z.object({
  enabled: z.boolean(),
  includeWarnings: z.boolean(),
  url: z.string().trim().max(2048).optional(),
  removeUrl: z.boolean().optional(),
});
const opsWebhookTestSchema = z.object({ url: z.string().trim().max(2048).optional() });
const INVALID_WEBHOOK_URL = process.env.NODE_ENV === "production"
  ? "Enter a valid https:// webhook URL."
  : "Enter a valid http(s):// webhook URL.";

/** Save the operational alert webhook. The URL is write-only and encrypted. */
export async function saveOpsWebhookSettings(input: unknown): Promise<ActionResult> {
  const session = await requireSuperAdminMfa();
  if (await isActionRateLimited("action", session.user.id)) return { ok: false, error: "Too many requests. Try again shortly." };
  const parsed = opsWebhookSettingsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid alert webhook settings." };
  const { enabled, includeWarnings, removeUrl } = parsed.data;
  const url = parsed.data.url ? parseOpsWebhookUrl(parsed.data.url) : null;
  if (parsed.data.url && !url) return { ok: false, error: INVALID_WEBHOOK_URL };
  if (url && !(await isAllowedOpsWebhook(url))) return { ok: false, error: PRIVATE_WEBHOOK_ERROR };

  const existing = await prisma.instanceSetting.findUnique({ where: { id: INSTANCE_SETTINGS_ID }, select: { opsWebhookUrlEncrypted: true } });
  const hasUrl = Boolean(url) || (!removeUrl && Boolean(existing?.opsWebhookUrlEncrypted));
  if (enabled && !hasUrl) return { ok: false, error: "Add a webhook URL before turning alerts on." };

  const urlUpdate = url
    ? { opsWebhookUrlEncrypted: encryptInstanceConfigSecret(url) }
    : removeUrl ? { opsWebhookUrlEncrypted: null } : {};
  const flags = { opsWebhookEnabled: enabled && hasUrl, opsWebhookIncludeWarnings: includeWarnings };
  await prisma.instanceSetting.upsert({
    where: { id: INSTANCE_SETTINGS_ID },
    create: { id: INSTANCE_SETTINGS_ID, ...flags, ...urlUpdate },
    update: { ...flags, ...urlUpdate },
  });
  invalidateOpsAlertSettings();
  await recordAuditEvent({
    action: "OPS_WEBHOOK_SETTINGS_UPDATED", actorUserId: session.user.id, targetType: "InstanceSetting", targetId: INSTANCE_SETTINGS_ID,
    metadata: { enabled: flags.opsWebhookEnabled, includeWarnings, urlChanged: Boolean(url), urlRemoved: Boolean(removeUrl && !url) },
  });
  revalidatePath("/super-admin/settings");
  return { ok: true };
}

/** Post a test message to the entered URL, or to the saved one. */
export async function sendOpsWebhookTest(input: unknown): Promise<ActionResult> {
  const session = await requireSuperAdminMfa();
  if (await isActionRateLimited("action", session.user.id)) return { ok: false, error: "Too many requests. Try again shortly." };
  const parsed = opsWebhookTestSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: INVALID_WEBHOOK_URL };
  let url = parsed.data.url ? parseOpsWebhookUrl(parsed.data.url) : null;
  if (parsed.data.url && !url) return { ok: false, error: INVALID_WEBHOOK_URL };
  if (!url) {
    const existing = await prisma.instanceSetting.findUnique({ where: { id: INSTANCE_SETTINGS_ID }, select: { opsWebhookUrlEncrypted: true } });
    if (!existing?.opsWebhookUrlEncrypted) return { ok: false, error: "Enter a webhook URL to test." };
    try {
      url = decryptInstanceConfigSecret(existing.opsWebhookUrlEncrypted);
    } catch {
      return { ok: false, error: "The saved webhook URL could not be read. Enter it again." };
    }
  }
  const result = await sendOpsWebhookTestMessage(url);
  await recordAuditEvent({
    action: "OPS_WEBHOOK_TEST_SENT", actorUserId: session.user.id, targetType: "InstanceSetting", targetId: INSTANCE_SETTINGS_ID,
    metadata: { delivered: result.ok, savedUrl: !parsed.data.url },
  });
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}
