import "server-only";

import { prisma } from "@/lib/db";
import { decryptInstanceConfigSecret } from "@/lib/instanceConfigSecrets";
import { logOpsError } from "@/lib/opsAlerts";

export const INSTANCE_SETTINGS_ID = "global";
export const DEFAULT_EMAIL_FROM = "Space Works Events <noreply@localhost>";

/** A missing singleton row intentionally preserves the historical default. */
export async function isNewUserRegistrationEnabled(): Promise<boolean> {
  const settings = await prisma.instanceSetting.findUnique({
    where: { id: INSTANCE_SETTINGS_ID },
    select: { allowNewUserSignups: true },
  });
  return settings?.allowNewUserSignups ?? true;
}

// A bare address or `Name <address>`. Hostnames without a dot (e.g. localhost)
// stay valid for development relays.
const EMAIL_ADDRESS = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

/** Validate a sender (`EMAIL_FROM`-style) value without allowing header injection. */
export function isValidSenderAddress(value: string) {
  if (/[\r\n]/.test(value)) return false;
  const named = /^([^<>]{1,200}?)\s*<([^<>\s]+)>$/.exec(value);
  if (named) return named[1]!.trim().length > 0 && EMAIL_ADDRESS.test(named[2]!);
  return EMAIL_ADDRESS.test(value);
}

/** Whether a saved secret decrypts with this replica's key; the value is discarded. */
function isSecretReadable(encrypted: string | null | undefined) {
  if (!encrypted) return false;
  try {
    decryptInstanceConfigSecret(encrypted);
    return true;
  } catch {
    return false;
  }
}

/** Empty strings (as in `.env.example`) count as unset. */
function envValue(...names: string[]) {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

function defaultSmtpPort(secure: boolean) {
  return secure ? 465 : 587;
}

function envSmtpPort(secure: boolean) {
  const port = Number.parseInt(envValue("SMTP_PORT") ?? "", 10);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : defaultSmtpPort(secure);
}

export type ConfigSource = "database" | "environment" | "none";

export type GoogleSsoStatus = { source: ConfigSource; clientId?: string; hasSecret: boolean; secretUnreadable: boolean };

/**
 * Never pair a saved client ID with an environment secret (or the reverse):
 * a saved client ID uses only the saved secret, otherwise the environment pair.
 */
function resolveGoogle(settings: { googleClientId: string | null; googleClientSecretEncrypted: string | null } | null) {
  const savedId = settings?.googleClientId?.trim();
  if (savedId) {
    return { source: "database" as const, clientId: savedId, encryptedSecret: settings?.googleClientSecretEncrypted ?? null, envSecret: undefined };
  }
  const clientId = envValue("AUTH_GOOGLE_ID", "GOOGLE_CLIENT_ID");
  const envSecret = envValue("AUTH_GOOGLE_SECRET", "GOOGLE_CLIENT_SECRET");
  return { source: clientId ? "environment" as const : "none" as const, clientId, encryptedSecret: null, envSecret };
}

const GOOGLE_SELECT = { googleClientId: true, googleClientSecretEncrypted: true } as const;

async function readGoogleSsoSettings() {
  const settings = await prisma.instanceSetting.findUnique({ where: { id: INSTANCE_SETTINGS_ID }, select: GOOGLE_SELECT });
  const resolved = resolveGoogle(settings);
  if (!resolved.clientId) return null;
  // A saved client ID without a saved secret means Google is not configured.
  const clientSecret = resolved.source === "database"
    ? resolved.encryptedSecret ? decryptInstanceConfigSecret(resolved.encryptedSecret) : undefined
    : resolved.envSecret;
  return clientSecret ? { clientId: resolved.clientId, clientSecret } : null;
}

/**
 * Google SSO settings, read from the database on every call so a change saved
 * in Super admin → Settings applies on every replica without a restart.
 *
 * An unreadable configuration (for example a secret encrypted under another
 * `MFA_ENCRYPTION_KEY`) disables Google sign-in instead of failing: Auth.js
 * evaluates this for every `auth()` call, including the session check in the
 * root layout, so a throw here would take the whole site down.
 */
export async function getGoogleSsoSettings() {
  try {
    return await readGoogleSsoSettings();
  } catch (error) {
    logOpsError("[auth] Google sign-in settings could not be loaded; Google sign-in is unavailable", {
      level: "error",
      source: "auth",
      title: "Google sign-in settings could not be loaded",
      error,
    });
    return null;
  }
}

const GOOGLE_CLIENT_ID = /^[A-Za-z0-9._-]{1,200}\.apps\.googleusercontent\.com$/;

/** Split a comma-separated list of Google OAuth client ids. */
export function parseGoogleClientIdList(raw: string | null | undefined): string[] {
  return Array.from(new Set((raw ?? "").split(",").map((value) => value.trim()).filter(Boolean)));
}

export function isGoogleClientIdList(raw: string) {
  const ids = parseGoogleClientIdList(raw);
  return ids.length > 0 && ids.length <= 10 && ids.every((id) => GOOGLE_CLIENT_ID.test(id));
}

export function getMobileGoogleClientIdsFromEnv() {
  return parseGoogleClientIdList(envValue("GOOGLE_MOBILE_CLIENT_IDS")).filter((id) => GOOGLE_CLIENT_ID.test(id));
}

/**
 * The OAuth client ids of the Android and iOS apps, accepted as Google
 * ID-token audiences by the mobile API. A saved list overrides
 * `GOOGLE_MOBILE_CLIENT_IDS`; read on every call like the web client.
 */
export async function getMobileGoogleClientIds(): Promise<string[]> {
  const settings = await prisma.instanceSetting.findUnique({ where: { id: INSTANCE_SETTINGS_ID }, select: { googleMobileClientIds: true } });
  const saved = parseGoogleClientIdList(settings?.googleMobileClientIds).filter((id) => GOOGLE_CLIENT_ID.test(id));
  return saved.length > 0 ? saved : getMobileGoogleClientIdsFromEnv();
}

/** Secret-free description of where Google sign-in configuration comes from. */
export async function getGoogleSsoStatus(): Promise<GoogleSsoStatus> {
  const settings = await prisma.instanceSetting.findUnique({ where: { id: INSTANCE_SETTINGS_ID }, select: GOOGLE_SELECT });
  const resolved = resolveGoogle(settings);
  return {
    source: resolved.source,
    clientId: resolved.clientId,
    hasSecret: resolved.source === "database" ? Boolean(resolved.encryptedSecret) : Boolean(resolved.envSecret),
    secretUnreadable: resolved.source === "database" && Boolean(resolved.encryptedSecret) && !isSecretReadable(resolved.encryptedSecret),
  };
}

const EMAIL_SELECT = {
  emailFrom: true, smtpService: true, smtpHost: true, smtpPort: true,
  smtpSecure: true, smtpUser: true, smtpPasswordEncrypted: true, smtpAllowUnauthenticated: true,
} as const;

type EmailRow = {
  emailFrom: string | null; smtpService: string | null; smtpHost: string | null; smtpPort: number | null;
  smtpSecure: boolean; smtpUser: string | null; smtpPasswordEncrypted: string | null; smtpAllowUnauthenticated: boolean;
};

/** Effective, secret-free email configuration, safe to render for super-admins. */
export type EmailSettingsStatus = {
  /** Where every SMTP field comes from. Sources are never mixed. */
  source: ConfigSource;
  fromSource: "database" | "environment" | "default";
  from: string;
  service?: string;
  host?: string;
  port: number;
  secure: boolean;
  user?: string;
  hasPassword: boolean;
  /** A saved password exists but cannot be decrypted with this key. */
  passwordUnreadable: boolean;
  allowUnauthenticated: boolean;
};

/**
 * Saved SMTP settings (a service or host) replace the environment entirely:
 * no field falls back to `SMTP_*` individually, so a saved host can never be
 * overridden by an environment service or paired with environment credentials.
 */
function resolveEmail(settings: EmailRow | null): { status: EmailSettingsStatus; passwordRef: { encrypted?: string; plain?: string } } {
  const savedFrom = settings?.emailFrom?.trim();
  const envFrom = envValue("EMAIL_FROM");
  const from = savedFrom || envFrom || DEFAULT_EMAIL_FROM;
  const fromSource = savedFrom ? "database" as const : envFrom ? "environment" as const : "default" as const;
  const savedService = settings?.smtpService?.trim();
  const savedHost = settings?.smtpHost?.trim();
  if (settings && (savedService || savedHost)) {
    return { status: {
      source: "database", from, fromSource,
      service: savedService || undefined,
      host: savedService ? undefined : savedHost,
      port: settings.smtpPort ?? defaultSmtpPort(settings.smtpSecure),
      secure: settings.smtpSecure,
      user: settings.smtpUser?.trim() || undefined,
      hasPassword: Boolean(settings.smtpPasswordEncrypted),
      passwordUnreadable: false,
      allowUnauthenticated: settings.smtpAllowUnauthenticated,
    }, passwordRef: { encrypted: settings.smtpPasswordEncrypted ?? undefined } };
  }
  const service = envValue("SMTP_SERVICE");
  const host = envValue("SMTP_HOST");
  const secure = process.env.SMTP_SECURE === "true";
  const password = process.env.SMTP_PASSWORD || undefined;
  return { status: {
    source: service || host ? "environment" : "none", from, fromSource,
    service,
    host: service ? undefined : host,
    port: envSmtpPort(secure),
    secure,
    user: envValue("SMTP_USER"),
    hasPassword: Boolean(password),
    passwordUnreadable: false,
    allowUnauthenticated: process.env.SMTP_ALLOW_UNAUTHENTICATED === "1",
  }, passwordRef: { plain: password } };
}

async function loadEmailRow() {
  return prisma.instanceSetting.findUnique({ where: { id: INSTANCE_SETTINGS_ID }, select: EMAIL_SELECT });
}

/** Read at send time (no cache), so every replica applies saved settings at once. */
export async function getEmailSettings() {
  const { status, passwordRef } = resolveEmail(await loadEmailRow());
  const password = passwordRef.encrypted ? decryptInstanceConfigSecret(passwordRef.encrypted) : passwordRef.plain;
  return { ...status, password };
}

export async function getEmailSettingsStatus(): Promise<EmailSettingsStatus> {
  const { status, passwordRef } = resolveEmail(await loadEmailRow());
  return passwordRef.encrypted ? { ...status, passwordUnreadable: !isSecretReadable(passwordRef.encrypted) } : status;
}

export async function getEffectiveEmailConfigSource(): Promise<ConfigSource> {
  return (await getEmailSettingsStatus()).source;
}

export type BackupPosture = { source: ConfigSource; provider?: string; lastSuccessAt: Date | null; retentionDays?: number };

/**
 * Backup posture is display-only. Any saved backup field means the saved
 * fields are used together; otherwise the environment fallback is shown.
 */
export function resolveBackupPosture(settings: { backupProvider: string | null; backupLastSuccessAt: Date | null; backupRetentionDays: number | null } | null): BackupPosture {
  if (settings && (settings.backupProvider?.trim() || settings.backupLastSuccessAt || settings.backupRetentionDays != null)) {
    return {
      source: "database",
      provider: settings.backupProvider?.trim() || undefined,
      lastSuccessAt: settings.backupLastSuccessAt,
      retentionDays: settings.backupRetentionDays ?? undefined,
    };
  }
  const provider = envValue("BACKUP_PROVIDER");
  const lastRaw = envValue("BACKUP_LAST_SUCCESS_AT");
  const last = lastRaw ? new Date(lastRaw) : null;
  const retention = Number.parseInt(envValue("BACKUP_RETENTION_DAYS") ?? "", 10);
  const retentionDays = Number.isInteger(retention) && retention > 0 ? retention : undefined;
  const lastSuccessAt = last && !Number.isNaN(last.getTime()) ? last : null;
  return {
    source: provider || lastSuccessAt || retentionDays ? "environment" : "none",
    provider, lastSuccessAt, retentionDays,
  };
}

/** Paid events stay off until a super admin turns them on for the installation. */
export async function isPaidEventsEnabled(): Promise<boolean> {
  const settings = await prisma.instanceSetting.findUnique({
    where: { id: INSTANCE_SETTINGS_ID },
    select: { paidEventsEnabled: true },
  });
  return settings?.paidEventsEnabled ?? false;
}
