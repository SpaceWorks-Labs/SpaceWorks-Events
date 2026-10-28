import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const findUnique = vi.hoisted(() => vi.fn());
const decrypt = vi.hoisted(() => vi.fn((value: string) => `decrypted:${value}`));
const logOpsError = vi.hoisted(() => vi.fn());

vi.mock("@/lib/db", () => ({
  prisma: { instanceSetting: { findUnique } },
}));
vi.mock("@/lib/instanceConfigSecrets", () => ({ decryptInstanceConfigSecret: decrypt }));
vi.mock("@/lib/opsAlerts", () => ({ logOpsError }));

import {
  getEffectiveEmailConfigSource, getEmailSettings, getEmailSettingsStatus, getGoogleSsoSettings, getGoogleSsoStatus,
  getMobileGoogleClientIds, INSTANCE_SETTINGS_ID, isGoogleClientIdList, isNewUserRegistrationEnabled, isValidSenderAddress, resolveBackupPosture,
} from "@/lib/instanceSettings";

beforeEach(() => vi.clearAllMocks());

describe("instance signup setting", () => {
  it("allows new registrations when no singleton setting exists", async () => {
    findUnique.mockResolvedValue(null);

    await expect(isNewUserRegistrationEnabled()).resolves.toBe(true);
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: INSTANCE_SETTINGS_ID },
      select: { allowNewUserSignups: true },
    });
  });

  it("returns the super-admin configured value", async () => {
    findUnique.mockResolvedValue({ allowNewUserSignups: false });

    await expect(isNewUserRegistrationEnabled()).resolves.toBe(false);
  });
});

const SMTP_ENV = ["SMTP_SERVICE", "SMTP_HOST", "SMTP_PORT", "SMTP_SECURE", "SMTP_USER", "SMTP_PASSWORD", "SMTP_ALLOW_UNAUTHENTICATED", "EMAIL_FROM"];
const GOOGLE_ENV = ["AUTH_GOOGLE_ID", "AUTH_GOOGLE_SECRET", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"];
const BACKUP_ENV = ["BACKUP_PROVIDER", "BACKUP_LAST_SUCCESS_AT", "BACKUP_RETENTION_DAYS"];

function emailRow(overrides: Record<string, unknown> = {}) {
  return {
    emailFrom: null, smtpService: null, smtpHost: null, smtpPort: null, smtpSecure: false,
    smtpUser: null, smtpPasswordEncrypted: null, smtpAllowUnauthenticated: false, ...overrides,
  };
}

describe("effective email settings", () => {
  beforeEach(() => {
    for (const name of [...SMTP_ENV, ...GOOGLE_ENV, ...BACKUP_ENV]) vi.stubEnv(name, "");
    vi.stubEnv("SMTP_SERVICE", "gmail");
    vi.stubEnv("SMTP_USER", "env-user");
    vi.stubEnv("SMTP_PASSWORD", "env-password");
    vi.stubEnv("SMTP_PORT", "2525");
    vi.stubEnv("EMAIL_FROM", "Env Sender <env@example.test>");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("uses a saved host exclusively, never the environment service or credentials", async () => {
    findUnique.mockResolvedValue(emailRow({ smtpHost: "smtp.saved.test", smtpPort: 465, smtpSecure: true, smtpUser: "saved-user", smtpPasswordEncrypted: "enc" }));
    const settings = await getEmailSettings();
    expect(settings).toMatchObject({ source: "database", service: undefined, host: "smtp.saved.test", port: 465, secure: true, user: "saved-user", password: "decrypted:enc" });
    expect(JSON.stringify(settings)).not.toContain("env-");
    // The sender address still falls back on its own.
    expect(settings.from).toBe("Env Sender <env@example.test>");
  });

  it("does not borrow environment credentials or port when saved values are missing", async () => {
    findUnique.mockResolvedValue(emailRow({ smtpHost: "relay.internal", smtpAllowUnauthenticated: true }));
    const settings = await getEmailSettings();
    expect(settings).toMatchObject({ source: "database", host: "relay.internal", port: 587, user: undefined, password: undefined, allowUnauthenticated: true });
    expect(decrypt).not.toHaveBeenCalled();
  });

  it("uses the environment exclusively when no service or host is saved", async () => {
    findUnique.mockResolvedValue(emailRow({ smtpUser: "stale-user", smtpPasswordEncrypted: "stale", smtpPort: 25, emailFrom: "Saved <saved@example.test>" }));
    const settings = await getEmailSettings();
    expect(settings).toMatchObject({ source: "environment", service: "gmail", user: "env-user", password: "env-password", port: 2525, from: "Saved <saved@example.test>", fromSource: "database" });
    expect(decrypt).not.toHaveBeenCalled();
  });

  it("reports no configuration and the default sender when nothing is set", async () => {
    for (const name of SMTP_ENV) vi.stubEnv(name, "");
    findUnique.mockResolvedValue(null);
    await expect(getEmailSettingsStatus()).resolves.toMatchObject({ source: "none", fromSource: "default", from: "Space Works Events <noreply@localhost>", hasPassword: false });
    await expect(getEffectiveEmailConfigSource()).resolves.toBe("none");
  });

  it("never includes the password in the status view", async () => {
    findUnique.mockResolvedValue(emailRow({ smtpService: "ses", smtpUser: "saved-user", smtpPasswordEncrypted: "enc" }));
    const status = await getEmailSettingsStatus();
    expect(status).toMatchObject({ source: "database", service: "ses", hasPassword: true, passwordUnreadable: false });
    expect(status).not.toHaveProperty("password");
    expect(JSON.stringify(status)).not.toContain("decrypted:");
  });

  it("flags a saved password that this key cannot decrypt", async () => {
    findUnique.mockResolvedValue(emailRow({ smtpService: "ses", smtpUser: "saved-user", smtpPasswordEncrypted: "enc" }));
    decrypt.mockImplementationOnce(() => { throw new Error("unreadable"); });
    await expect(getEmailSettingsStatus()).resolves.toMatchObject({ hasPassword: true, passwordUnreadable: true });
  });
});

describe("Google SSO pairing", () => {
  beforeEach(() => {
    for (const name of GOOGLE_ENV) vi.stubEnv(name, "");
    vi.stubEnv("AUTH_GOOGLE_ID", "env-client");
    vi.stubEnv("AUTH_GOOGLE_SECRET", "env-secret");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("uses the saved client ID with the saved secret only", async () => {
    findUnique.mockResolvedValue({ googleClientId: "saved-client", googleClientSecretEncrypted: "enc" });
    await expect(getGoogleSsoSettings()).resolves.toEqual({ clientId: "saved-client", clientSecret: "decrypted:enc" });
  });

  it("treats a saved client ID without a saved secret as not configured", async () => {
    findUnique.mockResolvedValue({ googleClientId: "saved-client", googleClientSecretEncrypted: null });
    await expect(getGoogleSsoSettings()).resolves.toBeNull();
    await expect(getGoogleSsoStatus()).resolves.toEqual({ source: "database", clientId: "saved-client", hasSecret: false, secretUnreadable: false });
  });

  it("falls back to the environment pair, including the legacy names", async () => {
    findUnique.mockResolvedValue({ googleClientId: null, googleClientSecretEncrypted: "orphan" });
    await expect(getGoogleSsoSettings()).resolves.toEqual({ clientId: "env-client", clientSecret: "env-secret" });
    vi.stubEnv("AUTH_GOOGLE_ID", "");
    vi.stubEnv("AUTH_GOOGLE_SECRET", "");
    vi.stubEnv("GOOGLE_CLIENT_ID", "legacy-client");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "legacy-secret");
    await expect(getGoogleSsoSettings()).resolves.toEqual({ clientId: "legacy-client", clientSecret: "legacy-secret" });
    expect(decrypt).not.toHaveBeenCalled();
  });

  it("turns Google sign-in off, instead of failing every request, when the saved secret cannot be read", async () => {
    findUnique.mockResolvedValue({ googleClientId: "saved-client", googleClientSecretEncrypted: "enc" });
    decrypt.mockImplementationOnce(() => { throw new Error("Unsupported state or unable to authenticate data"); });
    await expect(getGoogleSsoSettings()).resolves.toBeNull();
    expect(logOpsError).toHaveBeenCalledOnce();
    expect(logOpsError.mock.calls[0]?.[1]).toMatchObject({ level: "error", source: "auth" });
  });

  it("reads the settings on every call, so a saved change applies without a restart", async () => {
    findUnique
      .mockResolvedValueOnce({ googleClientId: "first", googleClientSecretEncrypted: "a" })
      .mockResolvedValueOnce({ googleClientId: "second", googleClientSecretEncrypted: "b" });
    await expect(getGoogleSsoSettings()).resolves.toEqual({ clientId: "first", clientSecret: "decrypted:a" });
    await expect(getGoogleSsoSettings()).resolves.toEqual({ clientId: "second", clientSecret: "decrypted:b" });
  });
});

describe("backup posture", () => {
  beforeEach(() => {
    vi.stubEnv("BACKUP_PROVIDER", "env-provider");
    vi.stubEnv("BACKUP_RETENTION_DAYS", "30");
    vi.stubEnv("BACKUP_LAST_SUCCESS_AT", "");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("uses saved fields together and the environment only when none are saved", () => {
    expect(resolveBackupPosture({ backupProvider: "saved", backupLastSuccessAt: null, backupRetentionDays: null }))
      .toEqual({ source: "database", provider: "saved", lastSuccessAt: null, retentionDays: undefined });
    expect(resolveBackupPosture({ backupProvider: null, backupLastSuccessAt: null, backupRetentionDays: null }))
      .toEqual({ source: "environment", provider: "env-provider", lastSuccessAt: null, retentionDays: 30 });
  });
});

describe("sender address validation", () => {
  it.each(["noreply@example.test", "Space Works Events <noreply@example.test>", "\"Space Works, Events\" <noreply@localhost>"])("accepts %s", (value) => {
    expect(isValidSenderAddress(value)).toBe(true);
  });
  it.each(["not-an-address", "Name <>", "<a@example.test>", "Name <a@example.test>\r\nBcc: x@example.test", "a@b@example.test"])("rejects %s", (value) => {
    expect(isValidSenderAddress(value)).toBe(false);
  });
});

describe("mobile Google client ids", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("prefers saved ids over GOOGLE_MOBILE_CLIENT_IDS and ignores malformed entries", async () => {
    vi.stubEnv("GOOGLE_MOBILE_CLIENT_IDS", "1-env.apps.googleusercontent.com, nonsense");
    findUnique.mockResolvedValue(null);
    await expect(getMobileGoogleClientIds()).resolves.toEqual(["1-env.apps.googleusercontent.com"]);
    findUnique.mockResolvedValue({ googleMobileClientIds: "2-android.apps.googleusercontent.com,3-ios.apps.googleusercontent.com" });
    await expect(getMobileGoogleClientIds()).resolves.toEqual(["2-android.apps.googleusercontent.com", "3-ios.apps.googleusercontent.com"]);
  });

  it("validates a saved list", () => {
    expect(isGoogleClientIdList("2-a.apps.googleusercontent.com, 3-b.apps.googleusercontent.com")).toBe(true);
    expect(isGoogleClientIdList("https://evil.example")).toBe(false);
  });
});
