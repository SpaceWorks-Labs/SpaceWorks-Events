import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireSuperAdminMfa: vi.fn(),
  rateLimit: vi.fn(),
  findSetting: vi.fn(),
  upsertSetting: vi.fn(),
  encrypt: vi.fn(),
  decrypt: vi.fn(),
  audit: vi.fn(),
  revalidate: vi.fn(),
  deliver: vi.fn(),
  tokenDelete: vi.fn(),
  outboxUpdate: vi.fn(),
  getTransport: vi.fn(),
  sendMail: vi.fn(),
  closeTransport: vi.fn(),
  reportOpsAlert: vi.fn(),
  allowedWebhook: vi.fn(),
}));

vi.mock("@/lib/permissions", () => ({ requireSuperAdminMfa: mocks.requireSuperAdminMfa }));
vi.mock("@/lib/actionRateLimit", () => ({ isActionRateLimited: mocks.rateLimit }));
vi.mock("@/lib/db", () => ({ prisma: {
  instanceSetting: { findUnique: mocks.findSetting, upsert: mocks.upsertSetting },
  verificationToken: { deleteMany: mocks.tokenDelete },
  outboxMessage: { updateMany: mocks.outboxUpdate },
} }));
vi.mock("@/lib/instanceConfigSecrets", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/instanceConfigSecrets")>()),
  encryptInstanceConfigSecret: mocks.encrypt, decryptInstanceConfigSecret: mocks.decrypt,
}));
vi.mock("@/lib/audit", () => ({ recordAuditEvent: mocks.audit }));
vi.mock("@/lib/opsWebhookAddress", () => ({ isAllowedOpsWebhook: mocks.allowedWebhook, PRIVATE_WEBHOOK_ERROR: "That webhook address points to a private or local network." }));
vi.mock("@/lib/outbox", () => ({ deliverOutboxBatch: mocks.deliver }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
vi.mock("@/lib/email/transporter", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email/transporter")>()),
  getPlatformTransport: mocks.getTransport,
}));
vi.mock("@/lib/opsAlerts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/opsAlerts")>()),
  reportOpsAlert: mocks.reportOpsAlert,
}));

import { saveInstanceServiceSettings, saveOpsWebhookSettings, sendSettingsTestEmail, sendOpsWebhookTest } from "@/app/actions/instance-settings";
import { EmailTransportUnavailableError } from "@/lib/email/transporter";
import { InstanceSecretUnreadableError } from "@/lib/instanceConfigSecrets";
import {
  deliverInstanceOutbox,
  purgeExpiredVerificationTokens,
  recordBackupRestoreVerification,
  retryFailedOutboxMessages,
} from "@/app/actions/instance";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireSuperAdminMfa.mockResolvedValue({ user: { id: "admin_1", email: "operator@example.test" } });
  mocks.sendMail.mockResolvedValue({ accepted: ["operator@example.test"], rejected: [] });
  mocks.getTransport.mockResolvedValue({ from: "Space Works Events <noreply@example.test>", source: "database", transporter: { sendMail: mocks.sendMail, close: mocks.closeTransport } });
  mocks.rateLimit.mockResolvedValue(false);
  mocks.allowedWebhook.mockResolvedValue(true);
  mocks.findSetting.mockResolvedValue(null);
  mocks.encrypt.mockImplementation((value: string) => `encrypted:${value}`);
  mocks.deliver.mockResolvedValue({ sent: 1, failed: 0 });
  mocks.tokenDelete.mockResolvedValue({ count: 2 });
  mocks.outboxUpdate.mockResolvedValue({ count: 3 });
});

describe("super-admin instance mutations", () => {
  it("requires the action-level fresh MFA gate for every maintenance mutation", async () => {
    await deliverInstanceOutbox();
    await purgeExpiredVerificationTokens();
    await retryFailedOutboxMessages();
    await recordBackupRestoreVerification();

    expect(mocks.requireSuperAdminMfa).toHaveBeenCalledTimes(4);
    expect(mocks.rateLimit).toHaveBeenCalledTimes(4);
  });

  it("never passes plaintext form secrets or unknown secret fields to Prisma", async () => {
    await expect(saveInstanceServiceSettings({
      emailFrom: "sender@example.test",
      smtpHost: "smtp.example.test",
      smtpPort: 465,
      smtpSecure: true,
      smtpUser: "sender@example.test",
      smtpPassword: "smtp-plaintext",
      smtpAllowUnauthenticated: false,
      googleClientId: "google-client",
      googleClientSecret: "google-plaintext",
    })).resolves.toEqual({ ok: true });

    const call = mocks.upsertSetting.mock.calls[0]?.[0];
    expect(call.create).not.toHaveProperty("smtpPassword");
    expect(call.create).not.toHaveProperty("googleClientSecret");
    expect(call.update).not.toHaveProperty("smtpPassword");
    expect(call.update).not.toHaveProperty("googleClientSecret");
    expect(call.create.smtpPasswordEncrypted).toBe("encrypted:smtp-plaintext");
    expect(call.create.googleClientSecretEncrypted).toBe("encrypted:google-plaintext");
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({
      metadata: { smtpConfigured: true, smtpPasswordChanged: true, googleSsoConfigured: true, googleSecretChanged: true, googleMobileClients: false, backupConfigured: false },
    }));
  });

  it("rate limits before invoking an operational mutation", async () => {
    mocks.rateLimit.mockResolvedValue(true);
    await expect(deliverInstanceOutbox()).resolves.toEqual({
      ok: false,
      error: "Too many requests. Try again shortly.",
    });
    expect(mocks.deliver).not.toHaveBeenCalled();
  });
});

describe("super-admin alert webhook settings", () => {
  const url = "https://chat.example.test/hooks/secret-hook-key";

  it("encrypts the webhook URL and keeps it out of audit metadata", async () => {
    await expect(saveOpsWebhookSettings({ enabled: true, includeWarnings: false, url })).resolves.toEqual({ ok: true });

    expect(mocks.requireSuperAdminMfa).toHaveBeenCalled();
    const upsert = mocks.upsertSetting.mock.calls[0]![0];
    expect(upsert.create).toMatchObject({ opsWebhookEnabled: true, opsWebhookIncludeWarnings: false, opsWebhookUrlEncrypted: `encrypted:${url}` });
    expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain("secret-hook-key");
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "OPS_WEBHOOK_SETTINGS_UPDATED", metadata: expect.objectContaining({ urlChanged: true }) }));
  });

  it("refuses a webhook that points to a private network", async () => {
    mocks.allowedWebhook.mockResolvedValue(false);
    await expect(saveOpsWebhookSettings({ enabled: true, includeWarnings: true, url: "https://10.0.0.5/hooks/x" })).resolves.toMatchObject({ ok: false, error: expect.stringContaining("private") });
    expect(mocks.upsertSetting).not.toHaveBeenCalled();
  });

  it("rejects non-http(s) URLs and enabling without a URL", async () => {
    await expect(saveOpsWebhookSettings({ enabled: true, includeWarnings: true, url: "javascript:alert(1)" })).resolves.toMatchObject({ ok: false });
    await expect(saveOpsWebhookSettings({ enabled: true, includeWarnings: true })).resolves.toEqual({ ok: false, error: "Add a webhook URL before turning alerts on." });
    expect(mocks.upsertSetting).not.toHaveBeenCalled();
  });

  it("keeps the saved URL when left blank, and removing it turns alerts off", async () => {
    mocks.findSetting.mockResolvedValue({ opsWebhookUrlEncrypted: "encrypted:old" });
    await saveOpsWebhookSettings({ enabled: true, includeWarnings: true });
    expect(mocks.upsertSetting.mock.calls[0]![0].update).not.toHaveProperty("opsWebhookUrlEncrypted");

    await saveOpsWebhookSettings({ enabled: false, includeWarnings: true, removeUrl: true });
    expect(mocks.upsertSetting.mock.calls[1]![0].update).toEqual({ opsWebhookEnabled: false, opsWebhookIncludeWarnings: true, opsWebhookUrlEncrypted: null });
  });

  it("sends a test message to the saved URL and reports HTTP failures without echoing the URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      mocks.findSetting.mockResolvedValue({ opsWebhookUrlEncrypted: "encrypted:saved" });
      mocks.decrypt.mockReturnValue(url);
      const result = await sendOpsWebhookTest({});
      expect(fetchMock).toHaveBeenCalledWith(url, expect.objectContaining({ method: "POST" }));
      expect(result).toEqual({ ok: false, error: "The webhook responded with HTTP 404." });
      expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain("secret-hook-key");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

const smtpBase = { smtpSecure: false, smtpAllowUnauthenticated: false };

describe("instance service settings edge cases", () => {
  it("switching from a service to a host clears the service and keeps the saved password", async () => {
    mocks.findSetting.mockResolvedValue({ smtpPasswordEncrypted: "encrypted:old", googleClientSecretEncrypted: null });
    await expect(saveInstanceServiceSettings({ ...smtpBase, smtpService: "", smtpHost: "smtp.example.test", smtpPort: "2525", smtpUser: "user" })).resolves.toEqual({ ok: true });
    const update = mocks.upsertSetting.mock.calls[0]![0].update;
    expect(update).toMatchObject({ smtpService: null, smtpHost: "smtp.example.test", smtpPort: 2525, smtpUser: "user" });
    expect(update).not.toHaveProperty("smtpPasswordEncrypted");
  });

  it("switching to a service clears the host and port", async () => {
    mocks.findSetting.mockResolvedValue({ smtpPasswordEncrypted: "encrypted:old", googleClientSecretEncrypted: null });
    await saveInstanceServiceSettings({ ...smtpBase, smtpService: "gmail", smtpHost: "", smtpPort: "", smtpUser: "user" });
    expect(mocks.upsertSetting.mock.calls[0]![0].update).toMatchObject({ smtpService: "gmail", smtpHost: null, smtpPort: null });
  });

  it("rejects a service and a host together", async () => {
    await expect(saveInstanceServiceSettings({ ...smtpBase, smtpService: "gmail", smtpHost: "smtp.example.test", smtpUser: "u", smtpPassword: "p" })).resolves.toMatchObject({ ok: false });
    expect(mocks.upsertSetting).not.toHaveBeenCalled();
  });

  it("clearing SMTP clears every stored SMTP field, including the password", async () => {
    mocks.findSetting.mockResolvedValue({ smtpPasswordEncrypted: "encrypted:old", googleClientSecretEncrypted: "encrypted:g" });
    await expect(saveInstanceServiceSettings({ smtpSecure: true, smtpAllowUnauthenticated: true, smtpService: "", smtpHost: "", smtpPort: "465", smtpUser: "left-over" })).resolves.toEqual({ ok: true });
    expect(mocks.upsertSetting.mock.calls[0]![0].update).toMatchObject({
      smtpService: null, smtpHost: null, smtpPort: null, smtpSecure: false, smtpUser: null, smtpAllowUnauthenticated: false, smtpPasswordEncrypted: null,
    });
  });

  it("persists TLS and private relay flags", async () => {
    await saveInstanceServiceSettings({ smtpHost: "relay.internal", smtpSecure: true, smtpAllowUnauthenticated: true });
    expect(mocks.upsertSetting.mock.calls[0]![0].create).toMatchObject({ smtpHost: "relay.internal", smtpSecure: true, smtpAllowUnauthenticated: true, smtpUser: null, smtpPasswordEncrypted: null });
  });

  it("validates the sender address", async () => {
    await expect(saveInstanceServiceSettings({ ...smtpBase, emailFrom: "not an address" })).resolves.toMatchObject({ ok: false });
    await expect(saveInstanceServiceSettings({ ...smtpBase, emailFrom: "Events <events@example.test>" })).resolves.toEqual({ ok: true });
    expect(mocks.upsertSetting.mock.calls[0]![0].update.emailFrom).toBe("Events <events@example.test>");
  });

  it("clearing the Google client ID also clears the stored secret", async () => {
    mocks.findSetting.mockResolvedValue({ smtpPasswordEncrypted: null, googleClientSecretEncrypted: "encrypted:g" });
    await saveInstanceServiceSettings({ ...smtpBase, googleClientId: "" });
    expect(mocks.upsertSetting.mock.calls[0]![0].update).toMatchObject({ googleClientId: null, googleClientSecretEncrypted: null });
  });

  it("rejects a Google secret without a client ID", async () => {
    await expect(saveInstanceServiceSettings({ ...smtpBase, googleClientSecret: "secret" })).resolves.toMatchObject({ ok: false });
    expect(mocks.upsertSetting).not.toHaveBeenCalled();
  });

  it("clears backup posture fields when they are emptied", async () => {
    await saveInstanceServiceSettings({ ...smtpBase, backupProvider: "", backupLastSuccessAt: "", backupRetentionDays: "" });
    expect(mocks.upsertSetting.mock.calls[0]![0].update).toMatchObject({ backupProvider: null, backupLastSuccessAt: null, backupRetentionDays: null });
  });
});

describe("super-admin test email", () => {
  it("requires fresh MFA and is rate limited before touching SMTP", async () => {
    mocks.rateLimit.mockResolvedValue(true);
    await expect(sendSettingsTestEmail()).resolves.toEqual({ ok: false, error: "Too many requests. Try again shortly." });
    expect(mocks.requireSuperAdminMfa).toHaveBeenCalled();
    expect(mocks.getTransport).not.toHaveBeenCalled();
  });

  it("sends to the super-admin's own address and audits without it", async () => {
    await expect(sendSettingsTestEmail()).resolves.toEqual({ ok: true });
    expect(mocks.sendMail).toHaveBeenCalledWith(expect.objectContaining({ to: "operator@example.test", from: "Space Works Events <noreply@example.test>" }));
    expect(mocks.closeTransport).toHaveBeenCalled();
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "INSTANCE_TEST_EMAIL_SENT", metadata: { delivered: true, source: "database", error: null } }));
    expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain("@");
    expect(mocks.reportOpsAlert).not.toHaveBeenCalled();
  });

  it("returns a UI-safe error and alerts on SMTP failure", async () => {
    mocks.sendMail.mockRejectedValue(Object.assign(new Error("Invalid login for operator@example.test at smtp.example.test"), { code: "EAUTH" }));
    const result = await sendSettingsTestEmail();
    expect(result).toEqual({ ok: false, error: "The SMTP server rejected the username or password. (Error (EAUTH))" });
    expect(JSON.stringify(result)).not.toContain("operator@");
    expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain("@");
    expect(mocks.reportOpsAlert).toHaveBeenCalledWith(expect.objectContaining({ level: "warning", source: "email" }));
    expect(JSON.stringify(mocks.reportOpsAlert.mock.calls)).not.toContain("@");
  });

  it("reports missing configuration", async () => {
    mocks.getTransport.mockRejectedValue(new EmailTransportUnavailableError());
    await expect(sendSettingsTestEmail()).resolves.toMatchObject({ ok: false, error: expect.stringContaining("not configured") });
  });

  it("explains an unreadable saved password", async () => {
    mocks.getTransport.mockRejectedValue(new InstanceSecretUnreadableError());
    await expect(sendSettingsTestEmail()).resolves.toMatchObject({ ok: false, error: expect.stringContaining("MFA_ENCRYPTION_KEY") });
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ error: "InstanceSecretUnreadableError (ESECRETUNREADABLE)" }) }));
  });

  it("gives up after 15 seconds", async () => {
    vi.useFakeTimers();
    try {
      mocks.sendMail.mockReturnValue(new Promise(() => undefined));
      const pending = sendSettingsTestEmail();
      await vi.advanceTimersByTimeAsync(15_000);
      await expect(pending).resolves.toEqual({ ok: false, error: "The SMTP server did not respond within 15 seconds. (TimeoutError (ETIMEDOUT))" });
      expect(mocks.closeTransport).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
