import { getEmailTransport } from "./transporter";
import { emailLayout } from "./brand";
import { BODY_STYLE, escapeHtml, getBaseUrl, greeting, headerText, HEADING_STYLE } from "./index";
import { emailButton } from "./team";

/** Hackathon email (docs/HACKATHON.md), in the Space Works email layout. */

export async function sendSubmissionReceivedEmail(params: {
  to: string;
  eventTitle: string;
  projectTitle: string;
  teamName?: string;
  eventPath: string;
  recipientName?: string;
  messageId?: string;
}): Promise<void> {
  const { transporter, from } = await getEmailTransport();
  const eventUrl = `${getBaseUrl()}${params.eventPath}`;
  const salutation = greeting(params.recipientName);
  const subject = `Submission received · ${headerText(params.eventTitle)}`;
  const forTeam = params.teamName ? ` for team <strong>${escapeHtml(params.teamName)}</strong>` : "";
  const forTeamText = params.teamName ? ` for team "${params.teamName}"` : "";
  const html = emailLayout(escapeHtml(subject), `
          <h2 style="${HEADING_STYLE}">Your project is in</h2>
          <p style="${BODY_STYLE}">${salutation.html}<br><br>We received <strong>${escapeHtml(params.projectTitle)}</strong>${forTeam} for <strong>${escapeHtml(params.eventTitle)}</strong>.</p>
          <p style="${BODY_STYLE}">You can still edit or withdraw it until submissions close.</p>
          ${emailButton(eventUrl, "View the event")}`);
  const text = `${subject}\n\n${salutation.text}\n\nWe received "${params.projectTitle}"${forTeamText} for "${params.eventTitle}".\nYou can still edit or withdraw it until submissions close.\n\n${eventUrl}\n\nBest regards,\nSpace Works Events`;
  if (!transporter) {
    console.log("[EMAIL MOCK] submission confirmation queued");
    return;
  }
  await transporter.sendMail({ messageId: params.messageId, from, to: params.to, subject, text, html });
}

/**
 * A solo registrant's private submission link. The path carries a bearer
 * capability; never log it. Sent only to the registration's own address.
 */
export async function sendSubmissionLinkEmail(params: {
  to: string;
  eventTitle: string;
  submitPath: string;
  recipientName?: string;
  messageId?: string;
}): Promise<void> {
  const { transporter, from } = await getEmailTransport();
  const submitUrl = `${getBaseUrl()}${params.submitPath}`;
  const salutation = greeting(params.recipientName);
  const subject = `Your submission link · ${headerText(params.eventTitle)}`;
  const body = `Use this private link to draft, submit, edit or withdraw your project for "${params.eventTitle}". Keep it to yourself: anyone with it can change your submission. Requesting a new link retires this one.`;
  const html = emailLayout(escapeHtml(subject), `
          <h2 style="${HEADING_STYLE}">Submit your project</h2>
          <p style="${BODY_STYLE}">${salutation.html}<br><br>Use this private link to draft, submit, edit or withdraw your project for <strong>${escapeHtml(params.eventTitle)}</strong>. Keep it to yourself: anyone with it can change your submission. Requesting a new link retires this one.</p>
          ${emailButton(submitUrl, "Open your submission")}`);
  const text = `${subject}\n\n${salutation.text}\n\n${body}\n\n${submitUrl}\n\nBest regards,\nSpace Works Events`;
  if (!transporter) {
    console.log("[EMAIL MOCK] submission link queued");
    return;
  }
  await transporter.sendMail({ messageId: params.messageId, from, to: params.to, subject, text, html });
}

/** Results are published: link to the public results page. Never includes scores. */
export async function sendResultsPublishedEmail(params: {
  to: string;
  eventTitle: string;
  resultsPath: string;
  recipientName?: string;
  messageId?: string;
}): Promise<void> {
  const { transporter, from } = await getEmailTransport();
  const resultsUrl = `${getBaseUrl()}${params.resultsPath}`;
  const salutation = greeting(params.recipientName);
  const subject = `Results are out · ${headerText(params.eventTitle)}`;
  const html = emailLayout(escapeHtml(subject), `
          <h2 style="${HEADING_STYLE}">The results are in</h2>
          <p style="${BODY_STYLE}">${salutation.html}<br><br>The organisers of <strong>${escapeHtml(params.eventTitle)}</strong> have published the results. Thank you for taking part.</p>
          ${emailButton(resultsUrl, "See the results")}`);
  const text = `${subject}\n\n${salutation.text}\n\nThe organisers of "${params.eventTitle}" have published the results. Thank you for taking part.\n\n${resultsUrl}\n\nBest regards,\nSpace Works Events`;
  if (!transporter) {
    console.log("[EMAIL MOCK] results announcement queued");
    return;
  }
  await transporter.sendMail({ messageId: params.messageId, from, to: params.to, subject, text, html });
}

/** A round's finalists are announced: the entrant's project advanced. Links to the public results page; never scores. */
export async function sendFinalistsAnnouncedEmail(params: {
  to: string;
  eventTitle: string;
  roundName: string;
  projectTitle: string;
  resultsPath: string;
  recipientName?: string;
  messageId?: string;
}): Promise<void> {
  const { transporter, from } = await getEmailTransport();
  const resultsUrl = `${getBaseUrl()}${params.resultsPath}`;
  const salutation = greeting(params.recipientName);
  const subject = `You're through to ${headerText(params.roundName)} · ${headerText(params.eventTitle)}`;
  const html = emailLayout(escapeHtml(subject), `
          <h2 style="${HEADING_STYLE}">You're a finalist</h2>
          <p style="${BODY_STYLE}">${salutation.html}<br><br>Your project <strong>${escapeHtml(params.projectTitle)}</strong> has advanced to <strong>${escapeHtml(params.roundName)}</strong> of <strong>${escapeHtml(params.eventTitle)}</strong>. The organisers will share what happens next.</p>
          ${emailButton(resultsUrl, "See the finalists")}`);
  const text = `${subject}\n\n${salutation.text}\n\nYour project "${params.projectTitle}" has advanced to ${params.roundName} of "${params.eventTitle}". The organisers will share what happens next.\n\n${resultsUrl}\n\nBest regards,\nSpace Works Events`;
  if (!transporter) {
    console.log("[EMAIL MOCK] finalists announcement queued");
    return;
  }
  await transporter.sendMail({ messageId: params.messageId, from, to: params.to, subject, text, html });
}
