import { getEmailTransport } from "./transporter";
import { EMAIL_BUTTON_STYLE, EMAIL_COLORS, emailLayout } from "./brand";
import { BODY_STYLE, escapeHtml, getBaseUrl, headerText, HEADING_STYLE } from "./index";

/** Invitations to an event (invite-only guests) and to co-organise one. */

export async function sendEventInvitation(params: {
  to: string;
  eventTitle: string;
  organisationName: string;
  orgSlug: string;
  eventSlug: string;
  /** Validated by the outbox: a series invite's date page. */
  eventPath?: string;
  messageId?: string;
}): Promise<void> {
  const { transporter, from } = await getEmailTransport();
  const eventUrl = params.eventPath
    ? `${getBaseUrl()}${params.eventPath}`
    : `${getBaseUrl()}/${encodeURIComponent(params.orgSlug)}/${encodeURIComponent(params.eventSlug)}`;
  const safeTitle = escapeHtml(params.eventTitle);
  const safeOrganisationName = escapeHtml(params.organisationName);
  const safeEventUrl = escapeHtml(eventUrl);
  const subject = `You’re invited: ${headerText(params.eventTitle)}`;
  const text = `You’re invited to "${params.eventTitle}" by ${params.organisationName}.\n\nOpen the event and register with this email address:\n${eventUrl}\n\nSpace Works Events`;
  const html = emailLayout(escapeHtml(subject), `
          <h2 style="${HEADING_STYLE}">You’re invited</h2>
          <p style="${BODY_STYLE}"><strong>${safeOrganisationName}</strong> invited you to <strong>${safeTitle}</strong>.<br><br>Open the event and register with this email address.</p>
          <p style="margin:28px 0;"><a href="${safeEventUrl}" style="${EMAIL_BUTTON_STYLE}">View event</a></p>
          <p style="font-size:13px; color:${EMAIL_COLORS.inkMuted}; overflow-wrap:anywhere;">${safeEventUrl}</p>`);

  if (!transporter) {
    console.log("[EMAIL MOCK] event invitation queued");
    return;
  }

  await transporter.sendMail({ messageId: params.messageId, from, to: params.to, subject, text, html });
}

export async function sendCollaboratorInvitation(params: { to: string; eventTitle: string; inviteUrl: string; messageId?: string }) {
  const { transporter, from } = await getEmailTransport();
  const subject = `Co-organiser invitation: ${headerText(params.eventTitle)}`;
  const safeUrl = escapeHtml(params.inviteUrl);
  const text = `You have been invited to help organise "${params.eventTitle}" as a co-organiser.\n\nSign in with this email address to accept:\n${params.inviteUrl}\n\nSpace Works Events`;
  const html = emailLayout(escapeHtml(subject), `
          <h2 style="${HEADING_STYLE}">You’re invited to co-organise</h2>
          <p style="${BODY_STYLE}">You have been invited to help organise <strong>${escapeHtml(params.eventTitle)}</strong>.<br><br>Sign in with this email address to accept.</p>
          <p style="margin:28px 0;"><a href="${safeUrl}" style="${EMAIL_BUTTON_STYLE}">Accept invitation</a></p>
          <p style="font-size:13px; color:${EMAIL_COLORS.inkMuted}; overflow-wrap:anywhere;">${safeUrl}</p>`);
  if (!transporter) { console.log("[EMAIL MOCK] collaborator invitation queued"); return; }
  await transporter.sendMail({ messageId: params.messageId, from, to: params.to, subject, text, html });
}
