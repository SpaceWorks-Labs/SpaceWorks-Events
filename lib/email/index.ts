import type { RsvpStatus } from "@prisma/client";
import { getEmailTransport } from "./transporter";
import { calendarInviteFilename, createCalendarInvite, googleCalendarEventUrl } from "@/lib/calendarInvite";
import { safeTimeZone } from "@/lib/timeZone";
import { EMAIL_BUTTON_STYLE, EMAIL_COLORS, emailLayout } from "./brand";
import { DEFAULT_BROADCAST_DESIGN, inlineBroadcastStyles, isBroadcastDesign, renderBroadcastDesign, type BroadcastBrand, type BroadcastDesignId } from "./broadcastDesigns";

export const HEADING_STYLE = `margin-top: 0; color: ${EMAIL_COLORS.ink}; font-size: 20px; font-weight: 600;`;
export const BODY_STYLE = `font-size: 16px; line-height: 1.5; color: ${EMAIL_COLORS.inkMuted}; margin-bottom: 24px;`;

export function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]!);
}

export function headerText(value: string) {
  return value.replace(/[\u0000-\u001F\u007F]+/g, " ").trim().slice(0, 240);
}

export function greeting(name?: string) {
  const safeName = name?.replace(/[\u0000-\u001F\u007F]+/g, " ").trim().slice(0, 200);
  return safeName ? { html: `Hello ${escapeHtml(safeName)},`, text: `Hello ${safeName},` } : { html: "Hello,", text: "Hello," };
}

export function getBaseUrl(): string {
  return (process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
}

function formatEventDateTime(value: Date, timezone: string) {
  return value.toLocaleString("en-US", {
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

export async function sendRSVPConfirmation(params: {
  to: string;
  eventTitle: string;
  status: RsvpStatus;
  checkInToken?: string;
  calendarEvent?: {
    startDateTime: Date;
    endDateTime: Date;
    timezone: string;
    location?: string | null;
  };
  messageId?: string;
  recipientName?: string;
  /** Names the team for a registration on a TEAM event. */
  teamName?: string;
  /** The event takes applications (docs/ADMISSION.md): a pending registration is an application in review. */
  application?: boolean;
  /** The designed ticket as a PDF (docs/TICKET_DESIGNER.md), for confirmed registrations. */
  ticketPdf?: { filename: string; content: Buffer };
}): Promise<void> {
  const { transporter, from } = await getEmailTransport();
  const baseUrl = getBaseUrl();

  const ticketUrl = params.checkInToken ? `${baseUrl}/ticket/${params.checkInToken}` : null;
  const safeTitle = escapeHtml(params.eventTitle);
  const subjectTitle = headerText(params.eventTitle);
  const safeTicketUrl = ticketUrl ? escapeHtml(ticketUrl) : null;
  const calendarUrl = params.status === "CONFIRMED" && params.calendarEvent
    ? googleCalendarEventUrl({ ...params.calendarEvent, title: params.eventTitle })
    : null;
  const safeCalendarUrl = calendarUrl ? escapeHtml(calendarUrl) : null;
  const salutation = greeting(params.recipientName);
  const eventDetails = params.status === "CONFIRMED" && params.calendarEvent
    ? {
      startsAt: formatEventDateTime(params.calendarEvent.startDateTime, params.calendarEvent.timezone),
      endsAt: formatEventDateTime(params.calendarEvent.endDateTime, params.calendarEvent.timezone),
      location: params.calendarEvent.location?.trim() || null,
    }
    : null;

  let statusText = "Confirmed";
  let statusMessage = "Your RSVP has been confirmed. We look forward to seeing you!";
  if (params.status === "WAITLISTED") {
    statusText = "Waitlisted";
    statusMessage = "The event is currently at capacity, so you've been placed on the waitlist. We will notify you if a spot opens up!";
  } else if (params.status === "PENDING_APPROVAL" && params.application) {
    statusText = "Application received";
    statusMessage = "Your application is in. The organisers review every application and will email you with a decision. Nothing is charged now.";
  } else if (params.status === "PENDING_APPROVAL") {
    statusText = "Pending Approval";
    statusMessage = "Your RSVP is pending organizer approval. We will let you know once it's reviewed.";
  }

  const html = emailLayout(`RSVP ${statusText}: ${safeTitle}`, `
            <h2 style="${HEADING_STYLE}">RSVP Status: ${statusText}</h2>
            <p style="${BODY_STYLE}">
              ${salutation.html}<br><br>
              Thank you for registering for <strong>${safeTitle}</strong>${params.teamName ? ` with team <strong>${escapeHtml(params.teamName)}</strong>` : ""}. ${statusMessage}
            </p>
            ${eventDetails ? `
              <div style="margin: 24px 0; padding: 20px; border: 1px solid ${EMAIL_COLORS.line}; border-radius: 16px; background-color: ${EMAIL_COLORS.cream};">
                <h3 style="margin: 0 0 12px; color: ${EMAIL_COLORS.ink}; font-size: 16px; font-weight: 600;">Event details</h3>
                <p style="margin: 8px 0; font-size: 14px; line-height: 1.5;"><strong>Starts:</strong> ${escapeHtml(eventDetails.startsAt)}</p>
                <p style="margin: 8px 0; font-size: 14px; line-height: 1.5;"><strong>Ends:</strong> ${escapeHtml(eventDetails.endsAt)}</p>
                ${eventDetails.location ? `<p style="margin: 8px 0; font-size: 14px; line-height: 1.5;"><strong>Location:</strong> ${escapeHtml(eventDetails.location)}</p>` : ""}
              </div>
            ` : ""}
            ${safeCalendarUrl ? `
              <div style="text-align: center; margin: 24px 0;">
                <a href="${safeCalendarUrl}" style="${EMAIL_BUTTON_STYLE}">
                  Add to Google Calendar
                </a>
                <p style="font-size: 12px; color: ${EMAIL_COLORS.inkMuted}; margin: 12px 0 0;">An .ics calendar invite is also attached for other calendar apps.</p>
              </div>
            ` : ""}
            ${
              ticketUrl && params.status === "CONFIRMED"
                ? `
              <div style="text-align: center; margin: 32px 0;">
                <a href="${safeTicketUrl}" style="${EMAIL_BUTTON_STYLE}">
                  View Your Ticket & QR Code
                </a>
              </div>
              <p style="font-size: 14px; text-align: center; color: ${EMAIL_COLORS.inkMuted}; margin-bottom: 24px;">
                Or copy and paste this link: <br>
                <a href="${safeTicketUrl}" style="color: ${EMAIL_COLORS.teal}; text-decoration: underline;">${safeTicketUrl}</a>
              </p>
            `
                : ""
            }`);

  const text = `RSVP ${statusText}: ${params.eventTitle}\n\n${salutation.text}\n\nThank you for registering for "${params.eventTitle}"${params.teamName ? ` with team "${params.teamName}"` : ""}. ${statusMessage}${eventDetails ? `\n\nEvent details\nStarts: ${eventDetails.startsAt}\nEnds: ${eventDetails.endsAt}${eventDetails.location ? `\nLocation: ${eventDetails.location}` : ""}` : ""}${calendarUrl ? `\n\nAdd to Google Calendar: ${calendarUrl}\nAn .ics calendar invite is also attached for other calendar apps.` : ""}${ticketUrl && params.status === "CONFIRMED" ? `\n\nView your ticket here: ${ticketUrl}` : ""}\n\nBest regards,\nSpace Works Events`;

  if (!transporter) {
    // Email bodies can contain attendee PII and bearer ticket links. Mock
    // delivery must remain safe for shared developer and CI logs.
    console.log("[EMAIL MOCK] RSVP confirmation queued");
    return;
  }

  await transporter.sendMail({
    messageId: params.messageId,
    from,
    to: params.to,
    subject: `RSVP ${statusText}: ${subjectTitle}`,
    text,
    html,
    // `icalEvent` emits both a text/calendar MIME alternative (which mail
    // clients recognise as an add-to-calendar action) and an .ics fallback.
    icalEvent: params.status === "CONFIRMED" && params.calendarEvent
      ? {
        filename: calendarInviteFilename(params.eventTitle),
        content: createCalendarInvite({
          ...params.calendarEvent,
          title: params.eventTitle,
          uid: params.messageId?.replace(/[<>]/g, "") ?? `swe-${Date.now()}@calendar.swe.invalid`,
        }),
        method: "PUBLISH",
      }
      : undefined,
    ...(params.status === "CONFIRMED" && params.ticketPdf ? { attachments: [{ filename: params.ticketPdf.filename, content: params.ticketPdf.content, contentType: "application/pdf" }] } : {}),
  });
}

export async function sendApprovalNotification(params: {
  to: string;
  eventTitle: string;
  approved: boolean;
  messageId?: string;
  recipientName?: string;
  /** Team status changes name the team the decision applied to. */
  teamName?: string;
}): Promise<void> {
  const { transporter, from } = await getEmailTransport();

  const statusText = params.approved ? "Approved" : "Declined";
  const safeTitle = escapeHtml(params.eventTitle);
  const subjectTitle = headerText(params.eventTitle);
  const salutation = greeting(params.recipientName);
  const safeTeam = params.teamName ? ` (team <strong>${escapeHtml(params.teamName)}</strong>)` : "";
  const textTeam = params.teamName ? ` (team "${params.teamName}")` : "";
  const statusMessage = params.approved
    ? `Great news! Your RSVP request for <strong>${safeTitle}</strong>${safeTeam} has been approved by the organizer.`
    : `We regret to inform you that your RSVP request for <strong>${safeTitle}</strong>${safeTeam} has been declined by the organizer.`;

  const html = emailLayout(`RSVP Update: ${statusText}`, `
            <h2 style="${HEADING_STYLE}">RSVP Update: ${statusText}</h2>
            <p style="${BODY_STYLE}">
              ${salutation.html}<br><br>
              ${statusMessage}
            </p>`);

  const text = `RSVP Update: ${statusText}\n\n${salutation.text}\n\n${params.approved ? `Your RSVP for "${params.eventTitle}"${textTeam} was approved!` : `Your RSVP for "${params.eventTitle}"${textTeam} was declined.`}\n\nBest regards,\nSpace Works Events`;

  if (!transporter) {
    console.log("[EMAIL MOCK] RSVP update queued");
    return;
  }

  await transporter.sendMail({
    messageId: params.messageId,
    from,
    to: params.to,
    subject: `RSVP Update: ${statusText} - ${subjectTitle}`,
    text,
    html,
  });
}

export async function sendReminder(params: {
  to: string;
  eventTitle: string;
  startsAtIso: string;
  /** The event's own zone; the date is shown in it. */
  timezone?: string;
  location?: string;
  /** The guest's ticket, built at send time (never stored in the queue). */
  ticketUrl?: string;
  messageId?: string;
}): Promise<void> {
  const { transporter, from } = await getEmailTransport();

  const formattedDate = formatEventDateTime(new Date(params.startsAtIso), params.timezone ?? "UTC");
  const safeTitle = escapeHtml(params.eventTitle);
  const subjectTitle = headerText(params.eventTitle);
  const location = params.location?.trim();
  const ticketUrl = params.ticketUrl ? escapeHtml(params.ticketUrl) : null;

  const html = emailLayout(`Reminder: ${safeTitle}`, `
            <h2 style="${HEADING_STYLE}">See you soon</h2>
            <p style="${BODY_STYLE}">
              Hello,<br><br>
              This is a reminder that <strong>${safeTitle}</strong> starts soon.<br><br>
              <strong>When:</strong> ${escapeHtml(formattedDate)}${location ? `<br><strong>Where:</strong> ${escapeHtml(location)}` : ""}
            </p>${ticketUrl ? `
            <p style="margin:28px 0;"><a href="${ticketUrl}" style="${EMAIL_BUTTON_STYLE}">Open your ticket</a></p>
            <p style="font-size:13px; color:${EMAIL_COLORS.inkMuted};">Show the ticket's QR code at the door. Can't make it? Cancel from the ticket so someone else can have your place.</p>` : ""}`);

  const text = `Reminder: ${params.eventTitle}\n\nHello,\n\nThis is a reminder that "${params.eventTitle}" starts at ${formattedDate}.${location ? `\nWhere: ${location}` : ""}${params.ticketUrl ? `\n\nYour ticket: ${params.ticketUrl}\nCan't make it? Cancel from the ticket so someone else can have your place.` : ""}\n\nSpace Works Events`;

  if (!transporter) {
    console.log("[EMAIL MOCK] event reminder queued");
    return;
  }

  await transporter.sendMail({
    messageId: params.messageId,
    from,
    to: params.to,
    subject: `Reminder: ${subjectTitle} starts soon`,
    text,
    html,
  });
}

export { inlineBroadcastStyles };

/** The exact message a recipient receives; also used for the dashboard preview. */
export function buildBroadcastEmail(params: {
  subject: string;
  bodyHtml: string;
  bodyText: string;
  eventTitle: string;
  organisationName: string;
  design?: BroadcastDesignId;
  brand?: BroadcastBrand;
  /** Only the dashboard preview sets this (to ""), so site images load relative to the page. */
  imageBaseUrl?: string;
}) {
  const subject = headerText(params.subject) || headerText(params.eventTitle) || "Event update";
  const design = isBroadcastDesign(params.design) ? params.design : DEFAULT_BROADCAST_DESIGN;
  const html = renderBroadcastDesign(design, {
    subject,
    bodyHtml: params.bodyHtml,
    eventTitle: params.eventTitle,
    organisationName: params.organisationName,
    brand: params.brand ?? {},
    // Recipients need an absolute public address; without one, site images are left out.
    baseUrl: params.imageBaseUrl ?? (process.env.NEXT_PUBLIC_BASE_URL?.trim().replace(/\/$/, "") || null),
  });
  const text = `${params.bodyText.replace(/\r\n?/g, "\n").trim()}\n\n—\nYou are receiving this because you registered for "${params.eventTitle}" with ${params.organisationName}.`;
  return { subject, html, text };
}

/** Organiser-written broadcast to an existing registration. The body is sanitised HTML rendered per recipient. */
export async function sendEventBroadcast(params: {
  to: string;
  subject: string;
  bodyHtml: string;
  bodyText: string;
  eventTitle: string;
  organisationName: string;
  design?: BroadcastDesignId;
  brand?: BroadcastBrand;
  messageId?: string;
}): Promise<void> {
  const { transporter, from } = await getEmailTransport();
  const { subject, html, text } = buildBroadcastEmail(params);

  if (!transporter) {
    console.log("[EMAIL MOCK] event broadcast queued");
    return;
  }

  await transporter.sendMail({ messageId: params.messageId, from, to: params.to, subject, text, html });
}

export { sendTeamCreatedEmail, sendTeamMemberAddedEmail } from "./team";
export { sendCollaboratorInvitation, sendEventInvitation } from "./invitations";
export { sendFinalistsAnnouncedEmail, sendResultsPublishedEmail, sendSubmissionLinkEmail, sendSubmissionReceivedEmail } from "./judging";
