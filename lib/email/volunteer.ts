import { getEmailTransport } from "./transporter";
import { formatDayLong, formatTimeRange } from "@/lib/format/datetime";
import { safeTimeZone } from "@/lib/timeZone";
import { emailLayout } from "./brand";
import { BODY_STYLE, escapeHtml, getBaseUrl, greeting, headerText, HEADING_STYLE } from "./index";
import { emailButton } from "./team";

export type VolunteerNoticeKind = "approved" | "promoted" | "cancelled" | "certificate";

/**
 * Volunteer shift and certificate email (docs/VOLUNTEERS.md). Every message
 * links to the crew ticket, where "My shifts" lives; the link is a bearer
 * capability, so mock delivery never logs the body.
 */
export async function sendVolunteerNoticeEmail(params: {
  to: string;
  notice: VolunteerNoticeKind;
  eventTitle: string;
  checkInToken: string;
  recipientName?: string;
  timezone: string;
  shift?: { title: string; zone?: string; startsAt: Date; endsAt: Date };
  messageId?: string;
}): Promise<void> {
  const { transporter, from } = await getEmailTransport();
  const ticketUrl = `${getBaseUrl()}/ticket/${params.checkInToken}`;
  const salutation = greeting(params.recipientName);
  const event = headerText(params.eventTitle);
  const shiftTitle = params.shift ? headerText(params.shift.title) : "";
  const timeZone = safeTimeZone(params.timezone);
  const when = params.shift ? `${formatDayLong(params.shift.startsAt, timeZone)}, ${formatTimeRange(params.shift.startsAt, params.shift.endsAt, timeZone, { withZone: true })}` : "";
  const zone = params.shift?.zone?.trim() ?? "";
  const copy = {
    approved: { subject: `You're on the ${shiftTitle} shift for ${event}`, heading: "Your shift is confirmed", line: `You have a place on the ${shiftTitle} shift for ${params.eventTitle}.` },
    promoted: { subject: `A place opened up: ${shiftTitle} for ${event}`, heading: "You're off the waitlist", line: `A place opened up, so you now have a place on the ${shiftTitle} shift for ${params.eventTitle}.` },
    cancelled: { subject: `Your ${shiftTitle} shift for ${event} is cancelled`, heading: "Your shift is cancelled", line: `The organisers cancelled your place on the ${shiftTitle} shift for ${params.eventTitle}. Your crew ticket still works.` },
    certificate: { subject: `Your certificate for ${event} is ready`, heading: "Thank you for your help", line: `Your contributor certificate for ${params.eventTitle} is ready. Download it from your crew ticket.` },
  }[params.notice];
  const details = when ? `<p style="${BODY_STYLE}"><strong>When:</strong> ${escapeHtml(when)}${zone ? `<br><strong>Where:</strong> ${escapeHtml(zone)}` : ""}</p>` : "";
  const html = emailLayout(escapeHtml(copy.subject), `
          <h2 style="${HEADING_STYLE}">${escapeHtml(copy.heading)}</h2>
          <p style="${BODY_STYLE}">${salutation.html}<br><br>${escapeHtml(copy.line)}</p>
          ${details}
          ${emailButton(ticketUrl, "Open your crew ticket")}`);
  const text = `${copy.subject}\n\n${salutation.text}\n\n${copy.line}${when ? `\n\nWhen: ${when}${zone ? `\nWhere: ${zone}` : ""}` : ""}\n\nOpen your crew ticket: ${ticketUrl}\n\nBest regards,\nSpace Works Events`;
  if (!transporter) {
    console.log("[EMAIL MOCK] volunteer notice queued");
    return;
  }
  await transporter.sendMail({ messageId: params.messageId, from, to: params.to, subject: copy.subject, text, html });
}
