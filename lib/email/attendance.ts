import { getEmailTransport } from "./transporter";
import { EMAIL_BUTTON_STYLE, EMAIL_COLORS, emailLayout } from "./brand";
import { BODY_STYLE, escapeHtml, getBaseUrl, greeting, headerText, HEADING_STYLE } from "./index";
import { formatDayTime, formatTimeZoneName } from "@/lib/format/datetime";
import { safeTimeZone } from "@/lib/timeZone";
import type { AttendanceReleaseKind } from "@/lib/attendanceCheck";

/** Content of the "Are you still coming?" email (docs/ATTENDANCE.md); exported for the unit tests. */
export type AttendanceCheckEmailParams = {
  eventTitle: string;
  organisationName: string;
  startDateTime: Date;
  timezone: string;
  /** "Online", the venue, or empty. */
  location: string;
  /** Site-relative `/attend/{token}` path; made absolute with NEXT_PUBLIC_BASE_URL. */
  attendPath: string;
  recipientName?: string;
  /** A reminder to someone who has not replied yet. */
  reminder?: boolean;
  /**
   * What a "No" would release for this registration at delivery (release on
   * and the place can actually be released; lib/core/attendanceCheck/release.ts).
   * Only then does the email say a No gives the place up; otherwise a No is
   * just recorded. It never promises the waitlist.
   */
  releaseKind?: AttendanceReleaseKind | null;
  /** Absolute base for links; defaults to NEXT_PUBLIC_BASE_URL. */
  baseUrl?: string;
};

const SECONDARY_BUTTON_STYLE = `background-color: ${EMAIL_COLORS.panel}; color: ${EMAIL_COLORS.ink}; padding: 12px 26px; border-radius: 10px; border: 2px solid ${EMAIL_COLORS.ink}; text-decoration: none; font-weight: 600; font-size: 16px; display: inline-block;`;

function purposeOf(releaseKind: AttendanceReleaseKind | null | undefined) {
  if (releaseKind === "paid") return "Your answer helps them plan. If you can't come, answering No gives up your place so someone else can have it, and cancels your order under the event's refund policy.";
  if (releaseKind === "free") return "Your answer helps them plan. If you can't come, answering No gives up your place so someone else can have it.";
  return "Your answer helps them plan.";
}

export function buildAttendanceCheckEmail(params: AttendanceCheckEmailParams): { subject: string; html: string; text: string; } {
  const baseUrl = (params.baseUrl ?? getBaseUrl()).replace(/\/$/, "");
  const formUrl = `${baseUrl}${params.attendPath}`;
  const join = formUrl.includes("?") ? "&" : "?";
  const yesUrl = `${formUrl}${join}answer=yes`;
  const noUrl = `${formUrl}${join}answer=no`;
  const salutation = greeting(params.recipientName);
  const zone = safeTimeZone(params.timezone);
  const when = `${formatDayTime(params.startDateTime, zone)} ${formatTimeZoneName(params.startDateTime, zone)}`.trim();
  const where = params.location.replace(/[\u0000-\u001F\u007F]+/g, " ").trim().slice(0, 300);
  const subject = `${params.reminder ? "Reminder: are" : "Are"} you still coming to ${headerText(params.eventTitle)}?`;
  const purpose = purposeOf(params.releaseKind);
  const html = emailLayout(escapeHtml(subject), `
          <h2 style="${HEADING_STYLE}">Are you still coming?</h2>
          <p style="${BODY_STYLE}">${salutation.html}<br><br>${escapeHtml(params.organisationName)} would like to know whether you can still make it to <strong>${escapeHtml(params.eventTitle)}</strong>. ${escapeHtml(purpose)}</p>
          <table role="presentation" style="margin:16px 0; border-collapse:collapse; font-size:15px; color:${EMAIL_COLORS.ink};">
            <tr><td style="padding:4px 12px 4px 0; color:${EMAIL_COLORS.inkMuted};">When</td><td style="padding:4px 0;">${escapeHtml(when)}</td></tr>
            ${where ? `<tr><td style="padding:4px 12px 4px 0; color:${EMAIL_COLORS.inkMuted};">Where</td><td style="padding:4px 0;">${escapeHtml(where)}</td></tr>` : ""}
          </table>
          <p style="margin:24px 0 8px;"><a href="${escapeHtml(yesUrl)}" style="${EMAIL_BUTTON_STYLE} margin:6px 8px 6px 0;">Yes, I'll be there</a><a href="${escapeHtml(noUrl)}" style="${SECONDARY_BUTTON_STYLE} margin:6px 8px 6px 0;">No, I can't make it</a></p>
          <p style="font-size:13px; color:${EMAIL_COLORS.inkMuted};">Each button opens a short page where you confirm your answer. You can change it there until the event starts. This link is personal; please don't forward it.</p>
          <p style="font-size:13px; color:${EMAIL_COLORS.inkMuted}; overflow-wrap:anywhere;">${escapeHtml(formUrl)}</p>`);
  const text = [
    subject,
    "",
    salutation.text,
    "",
    `${params.organisationName} would like to know whether you can still make it to "${params.eventTitle}". ${purpose}`,
    "",
    `When: ${when}`,
    ...(where ? [`Where: ${where}`] : []),
    "",
    `Yes, I'll be there: ${yesUrl}`,
    `No, I can't make it: ${noUrl}`,
    "",
    "Each link opens a short page where you confirm your answer. You can change it there until the event starts. This link is personal; please don't forward it.",
    "",
    "Best regards,",
    "Space Works Events",
  ].join("\n");
  return { subject, html, text };
}

/** Sends one attendance confirmation question. The link is a bearer capability; never log it. */
export async function sendAttendanceCheckEmail(params: AttendanceCheckEmailParams & { to: string; messageId?: string; }): Promise<void> {
  const { transporter, from } = await getEmailTransport();
  const email = buildAttendanceCheckEmail(params);
  if (!transporter) {
    console.log("[EMAIL MOCK] attendance confirmation queued");
    return;
  }
  await transporter.sendMail({ messageId: params.messageId, from, to: params.to, subject: email.subject, text: email.text, html: email.html });
}
