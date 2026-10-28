import { getEmailTransport } from "./transporter";
import { calendarInviteFilename, createCalendarInvite } from "@/lib/calendarInvite";
import { formatDayLong, formatTimeRange } from "@/lib/format/datetime";
import { safeTimeZone } from "@/lib/timeZone";
import { emailLayout } from "./brand";
import { BODY_STYLE, escapeHtml, getBaseUrl, greeting, headerText, HEADING_STYLE } from "./index";
import { emailButton } from "./team";

/**
 * The crew ticket (docs/CREW.md): a free ticket for check-in, worded for the
 * organising team. The ticket link is a bearer capability, so mock delivery
 * never logs the body.
 */
export async function sendCrewTicketEmail(params: {
  to: string;
  eventTitle: string;
  checkInToken: string;
  recipientName?: string;
  role?: string;
  calendarEvent: { startDateTime: Date; endDateTime: Date; timezone: string; location?: string | null };
  /** The designed ticket as a PDF (docs/TICKET_DESIGNER.md). */
  ticketPdf?: { filename: string; content: Buffer };
  messageId?: string;
}): Promise<void> {
  const { transporter, from } = await getEmailTransport();
  const ticketUrl = `${getBaseUrl()}/ticket/${params.checkInToken}`;
  const salutation = greeting(params.recipientName);
  const subject = `You're on the crew for ${headerText(params.eventTitle)}`;
  const timeZone = safeTimeZone(params.calendarEvent.timezone);
  const when = `${formatDayLong(params.calendarEvent.startDateTime, timeZone)}, ${formatTimeRange(params.calendarEvent.startDateTime, params.calendarEvent.endDateTime, timeZone, { withZone: true })}`;
  const where = params.calendarEvent.location?.trim() || "";
  const role = params.role?.replace(/[\u0000-\u001F\u007F]+/g, " ").trim().slice(0, 120) || "";
  const html = emailLayout(escapeHtml(subject), `
          <h2 style="${HEADING_STYLE}">You're on the crew</h2>
          <p style="${BODY_STYLE}">${salutation.html}<br><br>You're on the crew for <strong>${escapeHtml(params.eventTitle)}</strong>${role ? ` as <strong>${escapeHtml(role)}</strong>` : ""}. This is your crew ticket: show it at check-in.</p>
          <p style="${BODY_STYLE}"><strong>When:</strong> ${escapeHtml(when)}${where ? `<br><strong>Where:</strong> ${escapeHtml(where)}` : ""}</p>
          ${emailButton(ticketUrl, "View your crew ticket")}`);
  const text = `${subject}\n\n${salutation.text}\n\nYou're on the crew for "${params.eventTitle}"${role ? ` as ${role}` : ""}. This is your crew ticket: show it at check-in.\n\nWhen: ${when}${where ? `\nWhere: ${where}` : ""}\n\nView your crew ticket: ${ticketUrl}\n\nBest regards,\nSpace Works Events`;
  if (!transporter) {
    console.log("[EMAIL MOCK] crew ticket queued");
    return;
  }
  await transporter.sendMail({
    messageId: params.messageId,
    from,
    to: params.to,
    subject,
    text,
    html,
    icalEvent: {
      filename: calendarInviteFilename(params.eventTitle),
      content: createCalendarInvite({ ...params.calendarEvent, title: params.eventTitle, uid: params.messageId?.replace(/[<>]/g, "") ?? `swe-${Date.now()}@calendar.swe.invalid` }),
      method: "PUBLISH",
    },
    ...(params.ticketPdf ? { attachments: [{ filename: params.ticketPdf.filename, content: params.ticketPdf.content, contentType: "application/pdf" }] } : {}),
  });
}
