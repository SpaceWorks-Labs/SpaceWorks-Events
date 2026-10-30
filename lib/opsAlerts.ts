import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";
import os from "node:os";
import { inspect } from "node:util";
import { prisma } from "@/lib/db";
import { decryptInstanceConfigSecret } from "@/lib/instanceConfigSecrets";
import { INSTANCE_SETTINGS_ID } from "@/lib/instanceSettings";
import { describeOperationalError, redactSensitiveText } from "@/lib/redactSensitiveText";
import { postOpsWebhook, PRIVATE_WEBHOOK_ERROR, type OpsWebhookPost } from "@/lib/opsWebhookAddress";

/**
 * Operational alerts posted to a super-admin configured incoming webhook
 * (Mattermost, or any Slack-compatible endpoint accepting `{ text }`).
 *
 * Alerting is strictly best effort: nothing here throws, request paths never
 * wait on it (except `onRequestError`, which Next.js asks to await), and alert
 * text is redacted because it leaves the instance. Repeats are collapsed and
 * the volume per process is capped so an error loop cannot flood the channel.
 */

export type OpsAlertLevel = "error" | "warning" | "info";

export type OpsAlert = {
  level: OpsAlertLevel;
  /** Short area name, e.g. "auth", "email", "request", "browser". */
  source: string;
  /** One-line human summary. Must not contain secrets; it is redacted anyway. */
  title: string;
  error?: unknown;
  context?: Record<string, string | number | boolean | null | undefined>;
};

type Target = { url: string; includeWarnings: boolean };

type State = {
  target?: { value: Target | null; expiresAt: number };
  recent: Map<string, { at: number; suppressed: number }>;
  windowStart: number;
  sentInWindow: number;
  dropped: number;
  browserWindowStart?: number;
  browserSentInWindow?: number;
  consoleForwarding?: boolean;
  unreadableLogged?: boolean;
};

const SETTINGS_TTL_MS = 60_000;
const DEDUPE_WINDOW_MS = 5 * 60_000;
const MAX_ALERTS_PER_MINUTE = 30;
/** Browser reports are unauthenticated, so they get their own small budget. */
const MAX_BROWSER_ALERTS_PER_MINUTE = 5;
const REQUEST_TIMEOUT_MS = 5_000;
const MAX_TEXT = 600;

// Shared across Next.js bundles (instrumentation, Server Actions, route handlers).
const STATE_KEY = Symbol.for("swe.opsAlerts.state");
const SCOPE_KEY = Symbol.for("swe.opsAlerts.scope");

function state(): State {
  const g = globalThis as typeof globalThis & { [STATE_KEY]?: State };
  g[STATE_KEY] ??= { recent: new Map(), windowStart: Date.now(), sentInWindow: 0, dropped: 0 };
  return g[STATE_KEY];
}

/** Marks work done on behalf of alert delivery so its own logs never re-alert. */
function deliveryScope(): AsyncLocalStorage<true> {
  const g = globalThis as typeof globalThis & { [SCOPE_KEY]?: AsyncLocalStorage<true> };
  g[SCOPE_KEY] ??= new AsyncLocalStorage<true>();
  return g[SCOPE_KEY];
}

/** Validate a webhook URL: https in production, no embedded user info. */
export function parseOpsWebhookUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    const allowHttp = process.env.NODE_ENV !== "production";
    if (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) return null;
    if (url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

/** Redaction for any text that leaves the instance in an alert. */
export function redactAlertText(value: string, max = MAX_TEXT): string {
  const redacted = redactSensitiveText(value)
    // Connection strings and other non-http URLs (postgres://, rediss://, smtp://).
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, "[redacted URL]")
    .replace(/\bBearer\s+[^\s"',]+/gi, "Bearer [redacted]")
    .replace(/\b(password|passwd|pwd|secret|token|key|code|signature|sig)=([^\s&"',]+)/gi, "$1=[redacted]")
    // Opaque bearer capabilities (ticket and order tokens are 24-character
    // cuid2/base64url, member IDs 22) are unbroken runs; file paths keep their
    // slashes and survive. Same threshold as sanitizeAlertPath.
    .replace(/[A-Za-z0-9_+=-]{20,}/g, "[redacted token]")
    // Text can come from anyone (browser reports, logged input): no line
    // breaks, no code-span breakouts, and no @channel or <!here> mentions.
    .replace(/[\r\n]+/g, " ")
    .replace(/`/g, "'")
    .replace(/@/g, "@\u200b")
    .replace(/<!/g, "<\u200b!");
  return redacted.length > max ? `${redacted.slice(0, max - 1)}…` : redacted;
}

/** Route paths can embed capabilities; keep only the shape of the path. */
export function sanitizeAlertPath(value: string): string {
  const path = value.split(/[?#]/, 1)[0] ?? "";
  return redactAlertText(
    path
      .split("/")
      .map((segment) => (/^[A-Za-z0-9_-]{20,}$/.test(segment) ? ":id" : segment))
      .join("/"),
    200,
  );
}

function errorParts(error: unknown) {
  if (error instanceof Error || (error && typeof error === "object" && "message" in error)) {
    const e = error as Error & { digest?: unknown; cause?: unknown; type?: unknown };
    const label = describeOperationalError(e);
    const type = typeof e.type === "string" && /^[A-Za-z]{1,40}$/.test(e.type) ? e.type : null;
    const message = typeof e.message === "string" ? redactAlertText(e.message.split("\n")[0] ?? "") : "";
    const cause = e.cause instanceof Error ? redactAlertText(`${e.cause.name}: ${e.cause.message.split("\n")[0]}`, 300) : null;
    const root = process.cwd();
    const frames = typeof e.stack === "string"
      ? e.stack.split("\n").filter((line) => line.trim().startsWith("at ")).slice(0, 5)
        .map((line) => redactAlertText(line.trim().split(root).join("."), 200))
      : [];
    const digest = typeof e.digest === "string" && /^[A-Za-z0-9@_-]{1,64}$/.test(e.digest) ? e.digest : null;
    return { label: type && type !== e.name ? `${label} [${type}]` : label, message, cause, frames, digest };
  }
  if (typeof error === "string") return { label: "Error", message: redactAlertText(error), cause: null, frames: [], digest: null };
  return null;
}

function instanceLabel() {
  for (const value of [process.env.NEXT_PUBLIC_BASE_URL, process.env.AUTH_URL]) {
    try {
      if (value) return new URL(value).host;
    } catch {
      // Fall through to the host name.
    }
  }
  return os.hostname();
}

const LEVEL_BADGE: Record<OpsAlertLevel, string> = {
  error: ":red_circle: **Error**",
  warning: ":large_orange_diamond: **Warning**",
  info: ":large_blue_circle: **Info**",
};

/** Builds the Markdown message body. Exported for tests. */
export function formatOpsAlert(alert: OpsAlert, notes: string[] = [], now = new Date()): string {
  const lines = [`${LEVEL_BADGE[alert.level]} · \`${redactAlertText(alert.source, 40)}\` — ${redactAlertText(alert.title, 200)}`];
  const parts = errorParts(alert.error);
  if (parts) {
    lines.push(`**Error:** \`${parts.label}\`${parts.message ? ` ${parts.message}` : ""}`);
    if (parts.cause) lines.push(`**Cause:** ${parts.cause}`);
    if (parts.digest) lines.push(`**Digest:** \`${parts.digest}\``);
  }
  const context = Object.entries(alert.context ?? {})
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${redactAlertText(key, 40)}: \`${redactAlertText(String(value), 200)}\``);
  if (context.length) lines.push(context.join(" · "));
  if (parts?.frames.length) lines.push("```", ...parts.frames, "```");
  lines.push(`_${instanceLabel()} · ${process.env.NODE_ENV ?? "unknown"} · ${now.toISOString()}_`);
  for (const note of notes) lines.push(`_${note}_`);
  return lines.join("\n");
}

async function loadTarget(): Promise<Target | null> {
  const s = state();
  if (s.target && s.target.expiresAt > Date.now()) return s.target.value;
  let value: Target | null = null;
  try {
    const settings = await prisma.instanceSetting.findUnique({
      where: { id: INSTANCE_SETTINGS_ID },
      select: { opsWebhookUrlEncrypted: true, opsWebhookEnabled: true, opsWebhookIncludeWarnings: true },
    });
    if (settings?.opsWebhookEnabled && settings.opsWebhookUrlEncrypted) {
      try {
        value = { url: decryptInstanceConfigSecret(settings.opsWebhookUrlEncrypted), includeWarnings: settings.opsWebhookIncludeWarnings };
      } catch {
        // Nowhere to alert to, so say it once per process in the server log.
        if (!s.unreadableLogged) console.error("[ops alerts] saved webhook URL cannot be decrypted with this MFA_ENCRYPTION_KEY; re-enter it in Super admin → Settings");
        s.unreadableLogged = true;
      }
    }
  } catch {
    // An unreachable database must not take alerting down with it, nor loop.
  }
  s.target = { value, expiresAt: Date.now() + SETTINGS_TTL_MS };
  return value;
}

/** Drop the cached webhook target after super-admin changes in this process. */
export function invalidateOpsAlertSettings() {
  state().target = undefined;
}

function fingerprint(alert: OpsAlert) {
  // An error that is logged by Next.js and reported by onRequestError shares
  // one fingerprint, so it reaches the channel once.
  if (alert.error instanceof Error) return `err:${alert.error.name}:${alert.error.message.slice(0, 200)}`;
  return `${alert.level}:${alert.source}:${alert.title.slice(0, 200)}`;
}

/** Decide whether to send now, and collect suppression notes. */
function admit(alert: OpsAlert, now: number): string[] | null {
  const s = state();
  for (const [key, entry] of s.recent) if (now - entry.at > DEDUPE_WINDOW_MS) s.recent.delete(key);
  const key = fingerprint(alert);
  const previous = s.recent.get(key);
  if (previous) {
    previous.suppressed += 1;
    return null;
  }
  if (alert.source === "browser") {
    // Varied crash reports must never use up the budget for server alerts.
    if (s.browserWindowStart == null || now - s.browserWindowStart >= 60_000) {
      s.browserWindowStart = now;
      s.browserSentInWindow = 0;
    }
    if ((s.browserSentInWindow ?? 0) >= MAX_BROWSER_ALERTS_PER_MINUTE) return null;
    s.browserSentInWindow = (s.browserSentInWindow ?? 0) + 1;
    s.recent.set(key, { at: now, suppressed: 0 });
    return [];
  }
  if (now - s.windowStart >= 60_000) {
    s.windowStart = now;
    s.sentInWindow = 0;
  }
  if (s.sentInWindow >= MAX_ALERTS_PER_MINUTE) {
    s.dropped += 1;
    return null;
  }
  s.sentInWindow += 1;
  s.recent.set(key, { at: now, suppressed: 0 });
  const notes: string[] = [];
  if (s.dropped) {
    notes.push(`${s.dropped} earlier alert(s) dropped by the per-minute cap.`);
    s.dropped = 0;
  }
  return notes;
}

/** Report the suppressed repeat count when a fingerprint's window closes. */
function scheduleRepeatSummary(alert: OpsAlert, target: Target) {
  const key = fingerprint(alert);
  const timer = setTimeout(() => {
    const entry = state().recent.get(key);
    if (!entry?.suppressed) return;
    const summary: OpsAlert = { level: alert.level, source: alert.source, title: `Repeated ${entry.suppressed} more time(s) in 5 min: ${alert.title}` };
    entry.suppressed = 0;
    void post(target.url, formatOpsAlert(summary));
  }, DEDUPE_WINDOW_MS);
  timer.unref?.();
}

export type OpsWebhookResult = { ok: true } | { ok: false; error: string };

async function post(url: string, text: string): Promise<OpsWebhookResult> {
  return deliveryScope().run(true, async () => {
    // The host is checked on every post (deliveries and the test), not only when
    // saved, and the connection is pinned to the addresses just checked.
    const outcome = await postOpsWebhook(url, JSON.stringify({ username: "Space Works Events", text }), REQUEST_TIMEOUT_MS)
      .catch((): OpsWebhookPost => ({ error: "unreachable" }));
    if ("status" in outcome) return outcome.status >= 200 && outcome.status < 300 ? { ok: true } : { ok: false, error: `The webhook responded with HTTP ${outcome.status}.` };
    if (outcome.error === "blocked") return { ok: false, error: PRIVATE_WEBHOOK_ERROR };
    return { ok: false, error: outcome.error === "timeout" ? "The webhook did not respond within 5 seconds." : "Could not reach the webhook." };
  });
}

/** Send an alert if alerting is configured. Never throws. */
export async function deliverOpsAlert(alert: OpsAlert): Promise<void> {
  try {
    if (deliveryScope().getStore()) return;
    const target = await deliveryScope().run(true, loadTarget);
    if (!target) return;
    if (alert.level === "warning" && !target.includeWarnings) return;
    const notes = admit(alert, Date.now());
    if (!notes) return;
    await post(target.url, formatOpsAlert(alert, notes));
    scheduleRepeatSummary(alert, target);
  } catch {
    // Alerting is best effort.
  }
}

/** Fire-and-forget variant for request paths and workers. */
export function reportOpsAlert(alert: OpsAlert): void {
  void deliverOpsAlert(alert);
}

/** Send a test message to a given URL, bypassing the enabled flag and throttles. */
export async function sendOpsWebhookTestMessage(url: string): Promise<OpsWebhookResult> {
  return post(url, formatOpsAlert({ level: "info", source: "test", title: "Test alert from Super-admin → Settings. Alerts are working." }));
}

/**
 * Keep the existing fixed operator log line (which must not carry error
 * detail) while sending the redacted detail to the alert channel. The console
 * line itself is not forwarded again.
 */
export function logOpsError(line: string, alert: OpsAlert) {
  deliveryScope().run(true, () => console.error(line));
  reportOpsAlert(alert);
}

/**
 * A browser navigating away mid-stream makes Next.js log these. They are not
 * server faults, so they never reach the channel. ECONNRESET is deliberately
 * not listed: SMTP or database resets are real problems.
 */
const CLIENT_DISCONNECT = /destination stream closed early|^ResponseAborted$|^aborted$/i;

export function isClientDisconnectNoise(args: unknown[]): boolean {
  return args.some((arg) => {
    if (arg instanceof Error) return CLIENT_DISCONNECT.test(arg.message) || CLIENT_DISCONNECT.test(arg.name);
    return typeof arg === "string" && /destination stream closed early/i.test(arg);
  });
}

function consoleAlert(level: "error" | "warning", args: unknown[]): OpsAlert {
  const error = args.find((arg): arg is Error => arg instanceof Error);
  const text = args
    .filter((arg) => !(arg instanceof Error))
    .map((arg) => (typeof arg === "string" ? arg : inspect(arg, { depth: 1, breakLength: Infinity })))
    .join(" ")
    .trim();
  const prefix = /^\[([^\]]{1,40})\]\s*/.exec(text);
  const title = (prefix ? text.slice(prefix[0].length) : text) || (error ? "Unhandled error" : "Logged problem");
  return { level, source: prefix?.[1] ?? "log", title: title.split("\n")[0] ?? title, error };
}

/**
 * Forward server `console.error`/`console.warn` lines (including Next.js'
 * own uncaught-exception and unhandled-rejection logging) as alerts. The
 * original console behaviour is unchanged.
 */
export function installOpsAlertForwarding() {
  const s = state();
  if (s.consoleForwarding) return;
  s.consoleForwarding = true;
  for (const [method, level] of [["error", "error"], ["warn", "warning"]] as const) {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
      original(...args);
      if (deliveryScope().getStore()) return;
      try {
        if (isClientDisconnectNoise(args)) return;
        const alert = consoleAlert(level, args);
        // Give onRequestError a moment to report the same error with route
        // context first; the shared fingerprint then collapses this copy.
        const timer = setTimeout(() => reportOpsAlert(alert), 1_500);
        timer.unref?.();
      } catch {
        // Never let alerting break logging.
      }
    };
  }
}
