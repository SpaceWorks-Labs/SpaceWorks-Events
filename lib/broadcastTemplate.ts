import type { BroadcastAttendanceFilter, RsvpStatus } from "@prisma/client";
import { safeTimeZone } from "@/lib/timeZone";
import { BROADCAST_STARTER_TEMPLATES } from "./broadcastTemplate/starterTemplates";

/**
 * Shared (server and browser) helpers for organiser email broadcasts.
 *
 * Subjects are plain text. Bodies are a restricted HTML subset produced by the
 * dashboard editor and sanitised on the server before storage. Both may contain
 * `{{placeholder}}` tokens that are resolved per recipient at delivery time.
 */

export const BROADCAST_SUBJECT_MAX = 150;
export const BROADCAST_BODY_MAX = 20000;

export const BROADCAST_PLACEHOLDERS = [
  { token: "{{name}}", label: "Attendee name", description: "The attendee's name, or “there” when none was given" },
  { token: "{{event}}", label: "Event title", description: "Event title" },
  { token: "{{eventDate}}", label: "Date & time", description: "Start date and time in the event's timezone" },
  { token: "{{location}}", label: "Location", description: "Venue, or “Online” for online events" },
  { token: "{{eventUrl}}", label: "Event page link", description: "Public event page link" },
  { token: "{{ticketLink}}", label: "Ticket link", description: "The recipient's private ticket link (confirmed registrations); otherwise the event page" },
  { token: "{{feedbackUrl}}", label: "Feedback form link", description: "The event's feedback form link (share it after opening the form)" },
  { token: "{{scheduleUrl}}", label: "Programme link", description: "The public programme and live schedule page" },
  { token: "{{organisation}}", label: "Organisation", description: "Organisation name" },
] as const;

export type BroadcastPlaceholder = (typeof BROADCAST_PLACEHOLDERS)[number]["token"];

/** Placeholders that may be used as a link or button destination. */
export const BROADCAST_URL_PLACEHOLDERS = ["ticketLink", "eventUrl", "feedbackUrl", "scheduleUrl"] as const;

export type BroadcastVariables = {
  name?: string | null;
  event: string;
  eventDate: string;
  location: string;
  eventUrl: string;
  ticketLink?: string | null;
  feedbackUrl: string;
  scheduleUrl: string;
  organisation: string;
};

export const BROADCAST_STATUS_OPTIONS: ReadonlyArray<{ value: RsvpStatus; label: string; hint: string }> = [
  { value: "CONFIRMED", label: "Confirmed", hint: "Registered with a place and a ticket" },
  { value: "WAITLISTED", label: "Waitlisted", hint: "Registered after capacity was reached" },
  { value: "PENDING_APPROVAL", label: "Pending approval", hint: "Awaiting an organiser decision" },
  { value: "REJECTED", label: "Rejected", hint: "Declined by an organiser" },
];

export const BROADCAST_ATTENDANCE_OPTIONS: ReadonlyArray<{ value: BroadcastAttendanceFilter; label: string }> = [
  { value: "ANY", label: "Everyone in the selected statuses" },
  { value: "CHECKED_IN", label: "Only people who checked in" },
  { value: "NOT_CHECKED_IN", label: "Only people who did not check in" },
];

const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const PLACEHOLDER_PATTERN = /\{\{\s*([a-zA-Z]+)\s*\}\}/g;

function cleanName(value?: string | null) {
  const trimmed = value?.replace(CONTROL_CHARACTERS, "").trim().slice(0, 200);
  return trimmed || "there";
}

/** Own properties only: `{{constructor}}` or `{{toString}}` must stay literal, not resolve to Object.prototype. */
function resolveValues(variables: BroadcastVariables): Record<string, string> {
  return {
    name: cleanName(variables.name),
    event: variables.event,
    eventDate: variables.eventDate,
    location: variables.location,
    eventUrl: variables.eventUrl,
    ticketLink: variables.ticketLink || variables.eventUrl,
    feedbackUrl: variables.feedbackUrl,
    scheduleUrl: variables.scheduleUrl,
    organisation: variables.organisation,
  };
}

export function escapeBroadcastHtml(value: string) {
  return value.replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]!);
}

/** Replace `{{token}}` placeholders in plain text (subjects). Unknown tokens stay visible so typos are caught in the preview. */
export function renderBroadcastTemplate(template: string, variables: BroadcastVariables): string {
  const values = resolveValues(variables);
  return template
    .replace(CONTROL_CHARACTERS, "")
    .replace(PLACEHOLDER_PATTERN, (match, key: string) => (Object.hasOwn(values, key) ? values[key]! : match));
}

/**
 * Replace placeholders inside already-sanitised HTML. Every value is
 * HTML-escaped, which is correct both for text nodes and for `href` attribute
 * values, so one pass covers `<a href="{{ticketLink}}">` and `Hello {{name}}`.
 */
export function renderBroadcastHtml(html: string, variables: BroadcastVariables): string {
  const values = resolveValues(variables);
  return html
    .replace(CONTROL_CHARACTERS, "")
    .replace(PLACEHOLDER_PATTERN, (match, key: string) => (Object.hasOwn(values, key) ? escapeBroadcastHtml(values[key]!) : match));
}

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(value: string) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === "#") {
      const code = entity[1]?.toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      // fromCodePoint throws past U+10FFFF; text can come from attendee names.
      return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

/** Plain-text alternative for mail clients that do not render HTML. */
export function broadcastHtmlToText(html: string): string {
  const text = html
    .replace(/\r\n?/g, "\n")
    .replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_match, href: string, inner: string) => {
      const label = inner.replace(/<[^>]+>/g, "").trim();
      // Label and URL stay encoded here: the whole text is decoded once below,
      // and decoding twice would turn an escaped "&amp;lt;" into "<".
      return label && decodeEntities(label) !== decodeEntities(href) ? `${label} (${href})` : href;
    })
    // The editor wraps list item text in a paragraph; keep one line per bullet.
    .replace(/<\/p>\s*(?=<\/li>)/gi, "")
    .replace(/<li\b[^>]*>/gi, "• ")
    .replace(/<\/li>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|h2|h3|ul|ol|blockquote)>/gi, "\n\n")
    .replace(/<[^>]+>/g, "");
  return decodeEntities(text)
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function formatBroadcastEventDate(start: Date, timezone: string): string {
  return start.toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: safeTimeZone(timezone),
    timeZoneName: "short",
  });
}

export { BROADCAST_STARTER_TEMPLATES } from "./broadcastTemplate/starterTemplates";
export type { BroadcastStarterTemplate } from "./broadcastTemplate/starterTemplates";

export function defaultBroadcastTemplate(): { subject: string; body: string } {
  const template = BROADCAST_STARTER_TEMPLATES[0]!;
  return { subject: template.subject, body: template.bodyHtml };
}

export function describeBroadcastAudience(statuses: readonly RsvpStatus[], attendance: BroadcastAttendanceFilter): string {
  const labels = BROADCAST_STATUS_OPTIONS.filter((option) => statuses.includes(option.value)).map((option) => option.label.toLowerCase());
  const statusText = labels.length === BROADCAST_STATUS_OPTIONS.length
    ? "all registrations"
    : labels.length === 0
      ? "no registrations"
      : `${labels.join(", ")} registrations`;
  if (attendance === "CHECKED_IN") return `${statusText} who checked in`;
  if (attendance === "NOT_CHECKED_IN") return `${statusText} who did not check in`;
  return statusText;
}

/** Example values for the live preview and the organiser test email. */
export function sampleBroadcastVariables(event: {
  title: string;
  startDateTime: Date;
  timezone: string;
  location: string;
  isOnline: boolean;
  eventUrl: string;
  organisationName: string;
}, recipientName?: string | null): BroadcastVariables {
  return {
    name: recipientName ?? "Priya",
    event: event.title,
    eventDate: formatBroadcastEventDate(event.startDateTime, event.timezone),
    location: event.isOnline ? "Online" : (event.location.trim() || "the venue"),
    eventUrl: event.eventUrl,
    ticketLink: event.eventUrl,
    feedbackUrl: `${event.eventUrl}/feedback`,
    scheduleUrl: `${event.eventUrl}/schedule`,
    organisation: event.organisationName,
  };
}
