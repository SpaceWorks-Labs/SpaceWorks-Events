import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ findSetting: vi.fn(), decrypt: vi.fn(), allowed: vi.fn(), fetch: vi.fn() }));

vi.mock("@/lib/db", () => ({ prisma: { instanceSetting: { findUnique: mocks.findSetting } } }));
vi.mock("@/lib/instanceConfigSecrets", () => ({ decryptInstanceConfigSecret: mocks.decrypt }));
// The real post checks the host and connects over a pinned socket (tests/unit/ops-webhook-address.test.ts); here it goes through a fetch-shaped mock.
vi.mock("@/lib/opsWebhookAddress", () => ({
  PRIVATE_WEBHOOK_ERROR: "private",
  postOpsWebhook: async (url: string, json: string) => (await mocks.allowed(url))
    ? { status: ((await mocks.fetch(url, { method: "POST", body: json })) as Response).status }
    : { error: "blocked" },
}));

import {
  deliverOpsAlert,
  formatOpsAlert,
  installOpsAlertForwarding,
  isClientDisconnectNoise,
  invalidateOpsAlertSettings,
  logOpsError,
  parseOpsWebhookUrl,
  redactAlertText,
  sanitizeAlertPath,
  sendOpsWebhookTestMessage,
} from "@/lib/opsAlerts";

const WEBHOOK = "https://chat.example.test/hooks/abc123";
const fetchMock = mocks.fetch;

function resetAlertState() {
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("swe.opsAlerts.state")];
}

function sentTexts() {
  return fetchMock.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string).text as string);
}

beforeEach(() => {
  vi.clearAllMocks();
  resetAlertState();
  invalidateOpsAlertSettings();
  mocks.findSetting.mockResolvedValue({ opsWebhookUrlEncrypted: "enc", opsWebhookEnabled: true, opsWebhookIncludeWarnings: true });
  mocks.decrypt.mockReturnValue(WEBHOOK);
  fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
  mocks.allowed.mockResolvedValue(true);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("alert text redaction", () => {
  it("removes connection strings, bearer values, query secrets, emails and opaque tokens", () => {
    const text = redactAlertText(
      "connect postgres://user:pw@db:5432/swevents failed for ana@example.test; Bearer sk_live_abc token=xyz ticket 3f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a",
    );
    expect(text).not.toContain("postgres://");
    expect(text).not.toContain("pw@db");
    expect(text).not.toContain("ana@example.test");
    expect(text).not.toContain("sk_live_abc");
    expect(text).not.toContain("xyz");
    expect(text).not.toContain("3f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a");
    expect(text).toContain("[redacted URL]");
  });

  it("removes 24-character ticket, transfer and order tokens", () => {
    for (const token of ["tz4a98xxat96iws9zmbrgj3a", "Qx7_2kLm9pZr-4Tb8VnW0cYe"]) {
      expect(redactAlertText(`lookup failed for ${token}`)).not.toContain(token);
    }
  });

  it("neutralises mentions, code-span breakouts and line breaks", () => {
    const text = redactAlertText("@channel <!here> `x` first\nsecond");
    expect(text).not.toMatch(/@channel|<!here>|`|\n/);
    expect(text).toContain("first second");
  });

  it("keeps file paths in stack frames readable and caps length", () => {
    expect(redactAlertText("at deliver (./lib/email/transporter.ts:42:7)")).toContain("lib/email/transporter.ts:42:7");
    expect(redactAlertText("x".repeat(20) + " ".repeat(1000), 50)).toHaveLength(50);
  });

  it("reduces request paths to their shape", () => {
    expect(sanitizeAlertPath("/t/Abcdefghijklmnopqrstuvwxyz012345?token=1#x")).toBe("/t/:id");
    expect(sanitizeAlertPath("/events/[slug]")).toBe("/events/[slug]");
  });
});

describe("webhook URL validation", () => {
  it("accepts https URLs and rejects other schemes and embedded credentials", () => {
    expect(parseOpsWebhookUrl(` ${WEBHOOK} `)).toBe(WEBHOOK);
    expect(parseOpsWebhookUrl("javascript:alert(1)")).toBeNull();
    expect(parseOpsWebhookUrl("https://user:pass@chat.example.test/hooks/x")).toBeNull();
    expect(parseOpsWebhookUrl("not a url")).toBeNull();
  });

  it("requires https in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(parseOpsWebhookUrl("http://chat.example.test/hooks/x")).toBeNull();
    vi.unstubAllEnvs();
    expect(parseOpsWebhookUrl("http://chat.example.test/hooks/x")).toBe("http://chat.example.test/hooks/x");
  });
});

describe("alert formatting", () => {
  it("includes the level, source, error type, code, and redacted message", () => {
    const error = Object.assign(new Error("Invalid login for ops@example.test"), { code: "EAUTH" });
    const text = formatOpsAlert({ level: "error", source: "email", title: "Email delivery failed", error, context: { kind: "rsvp" } }, [], new Date("2026-10-21T00:00:00Z"));
    expect(text).toContain("**Error**");
    expect(text).toContain("`email`");
    expect(text).toContain("Error (EAUTH)");
    expect(text).toContain("Invalid login for [redacted email]");
    expect(text).toContain("kind: `rsvp`");
    expect(text).toContain("2026-10-21T00:00:00.000Z");
  });

  it("names Auth.js error types", () => {
    const error = Object.assign(new Error("Callback failed"), { name: "CallbackRouteError", type: "OAuthCallbackError" });
    expect(formatOpsAlert({ level: "error", source: "auth", title: "Sign-in failed", error })).toContain("CallbackRouteError [OAuthCallbackError]");
  });
});

describe("alert delivery", () => {
  it("posts a Mattermost-compatible payload to the configured webhook", async () => {
    await deliverOpsAlert({ level: "error", source: "auth", title: "Sign-in failed" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(WEBHOOK);
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({ username: "Space Works Events", text: expect.stringContaining("Sign-in failed") });
  });

  it("never posts to a webhook whose host is private", async () => {
    mocks.allowed.mockResolvedValue(false);
    await deliverOpsAlert({ level: "error", source: "auth", title: "Sign-in failed" });
    await expect(sendOpsWebhookTestMessage(WEBHOOK)).resolves.toEqual({ ok: false, error: "private" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends nothing when alerts are off or no URL is saved", async () => {
    mocks.findSetting.mockResolvedValue({ opsWebhookUrlEncrypted: "enc", opsWebhookEnabled: false, opsWebhookIncludeWarnings: true });
    await deliverOpsAlert({ level: "error", source: "auth", title: "a" });
    invalidateOpsAlertSettings();
    mocks.findSetting.mockResolvedValue(null);
    await deliverOpsAlert({ level: "error", source: "auth", title: "b" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips warnings when they are excluded, but still sends errors", async () => {
    mocks.findSetting.mockResolvedValue({ opsWebhookUrlEncrypted: "enc", opsWebhookEnabled: true, opsWebhookIncludeWarnings: false });
    await deliverOpsAlert({ level: "warning", source: "email", title: "retrying" });
    await deliverOpsAlert({ level: "error", source: "email", title: "failed" });
    expect(sentTexts()).toHaveLength(1);
    expect(sentTexts()[0]).toContain("failed");
  });

  it("collapses repeats of the same error within the window", async () => {
    const error = new Error("SMTP down");
    await deliverOpsAlert({ level: "error", source: "email", title: "x", error });
    await deliverOpsAlert({ level: "error", source: "log", title: "y", error: new Error("SMTP down") });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("caps the number of alerts per minute", async () => {
    for (let i = 0; i < 40; i += 1) await deliverOpsAlert({ level: "error", source: "x", title: `distinct ${i}` });
    expect(fetchMock).toHaveBeenCalledTimes(30);
  });

  it("gives browser reports their own small budget, so they cannot crowd out server alerts", async () => {
    for (let i = 0; i < 20; i += 1) await deliverOpsAlert({ level: "error", source: "browser", title: `crash ${i}` });
    expect(fetchMock).toHaveBeenCalledTimes(5);
    await deliverOpsAlert({ level: "error", source: "request", title: "server error" });
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("never throws when the webhook or the database fails", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(deliverOpsAlert({ level: "error", source: "a", title: "b" })).resolves.toBeUndefined();
    invalidateOpsAlertSettings();
    mocks.findSetting.mockRejectedValue(new Error("db down"));
    await expect(deliverOpsAlert({ level: "error", source: "a", title: "c" })).resolves.toBeUndefined();
  });
});

describe("console forwarding", () => {
  it("forwards console.error lines with their [area] prefix, once", async () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const original = console.error;
    try {
      installOpsAlertForwarding();
      console.error("[rsvp] guest submission failed");
      logOpsError("[auth] Authentication failed", { level: "error", source: "auth", title: "Sign-in failed (OAuthCallbackError)" });
      await vi.advanceTimersByTimeAsync(2_000);
      const texts = sentTexts();
      expect(texts).toHaveLength(2);
      expect(texts.some((text) => text.includes("`rsvp`") && text.includes("guest submission failed"))).toBe(true);
      expect(texts.some((text) => text.includes("OAuthCallbackError"))).toBe(true);
      expect(texts.some((text) => text.includes("Authentication failed"))).toBe(false);
      expect(spy).toHaveBeenCalledWith("[rsvp] guest submission failed");
    } finally {
      console.error = original;
      spy.mockRestore();
    }
  });
});

describe("client disconnect noise", () => {
  it("ignores aborted client streams but keeps real connection resets", () => {
    expect(isClientDisconnectNoise([new Error("The destination stream closed early.")])).toBe(true);
    expect(isClientDisconnectNoise(["⨯", Object.assign(new Error("aborted"), { code: "ECONNRESET" })])).toBe(true);
    expect(isClientDisconnectNoise([Object.assign(new Error("x"), { name: "ResponseAborted" })])).toBe(true);
    expect(isClientDisconnectNoise([Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" })])).toBe(false);
    expect(isClientDisconnectNoise(["[rsvp] guest submission failed"])).toBe(false);
  });

  it("does not forward a disconnect logged to console.error", async () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const original = console.error;
    try {
      installOpsAlertForwarding();
      console.error(new Error("The destination stream closed early."));
      await vi.advanceTimersByTimeAsync(2_000);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      console.error = original;
      spy.mockRestore();
    }
  });
});
