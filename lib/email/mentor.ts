import { calendarInviteFilename, createCalendarInvite } from "@/lib/calendarInvite";
import { getEmailTransport } from "./transporter";
import { emailLayout } from "./brand";
import { BODY_STYLE, escapeHtml, getBaseUrl, greeting, headerText, HEADING_STYLE } from "./index";
import { emailButton } from "./team";

/*
 * Mentor Desk email (docs/MENTOR_DESK.md): transactional notices only, never
 * one per queue change. Help request text is never included. Paths are
 * site-relative and made absolute with NEXT_PUBLIC_BASE_URL.
 */

export type MentorNotice = {
  to: string;
  subject: string;
  heading: string;
  /** Plain sentences; escaped here. */
  lines: string[];
  action?: { path: string; label: string };
  calendar?: { uid: string; title: string; startDateTime: Date; endDateTime: Date; timezone: string; location?: string; description: string; cancelled?: boolean };
  recipientName?: string;
  messageId?: string;
};

export async function sendMentorNoticeEmail(params: MentorNotice): Promise<void> {
  const { transporter, from } = await getEmailTransport();
  const salutation = greeting(params.recipientName);
  const subject = headerText(params.subject);
  const actionUrl = params.action ? `${getBaseUrl()}${params.action.path}` : null;
  const html = emailLayout(escapeHtml(subject), `
          <h2 style="${HEADING_STYLE}">${escapeHtml(params.heading)}</h2>
          <p style="${BODY_STYLE}">${salutation.html}<br><br>${params.lines.map(escapeHtml).join("<br>")}</p>
          ${actionUrl && params.action ? emailButton(actionUrl, params.action.label) : ""}`);
  const text = `${subject}\n\n${salutation.text}\n\n${params.lines.join("\n")}${actionUrl ? `\n\n${actionUrl}` : ""}\n\nBest regards,\nSpace Works Events`;
  if (!transporter) {
    console.log("[EMAIL MOCK] mentor desk notice queued");
    return;
  }
  const calendar = params.calendar;
  await transporter.sendMail({
    messageId: params.messageId,
    from,
    to: params.to,
    subject,
    text,
    html,
    icalEvent: calendar && !calendar.cancelled
      ? {
        filename: calendarInviteFilename(calendar.title),
        content: createCalendarInvite({ ...calendar, uid: `${calendar.uid}@office-hours.swe.invalid` }),
        method: "PUBLISH",
      }
      : undefined,
  });
}
