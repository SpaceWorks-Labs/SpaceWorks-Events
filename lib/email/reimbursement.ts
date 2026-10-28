import { getEmailTransport } from "./transporter";
import { emailLayout } from "./brand";
import { BODY_STYLE, escapeHtml, getBaseUrl, greeting, headerText, HEADING_STYLE } from "./index";
import { emailButton } from "./team";

/**
 * "You can claim expenses" (docs/FINANCE.md "Reimbursement policies"): sent
 * once per person and policy when an organiser turned the email on. The
 * ticket path is made absolute with NEXT_PUBLIC_BASE_URL.
 */
export async function sendReimbursementAvailableEmail(params: {
  to: string;
  eventTitle: string;
  policyName: string;
  cap: string;
  closesAt: string | null;
  ticketPath: string;
  recipientName?: string;
  messageId?: string;
}): Promise<void> {
  const { transporter, from } = await getEmailTransport();
  const salutation = greeting(params.recipientName);
  const subject = headerText(`You can claim expenses: ${params.eventTitle}`);
  const lines = [
    `The organisers of ${params.eventTitle} pay back costs such as travel under "${params.policyName}", up to ${params.cap} per person, and you qualify.`,
    params.closesAt ? `Send your claim with photos of your receipts by ${params.closesAt}.` : "Send your claim with photos of your receipts from your ticket page.",
  ];
  const url = `${getBaseUrl()}${params.ticketPath}`;
  const html = emailLayout(escapeHtml(subject), `
          <h2 style="${HEADING_STYLE}">${escapeHtml("You can claim expenses")}</h2>
          <p style="${BODY_STYLE}">${salutation.html}<br><br>${lines.map(escapeHtml).join("<br>")}</p>
          ${emailButton(url, "Open your ticket")}`);
  const text = `${subject}\n\n${salutation.text}\n\n${lines.join("\n")}\n\n${url}\n\nBest regards,\nSpace Works Events`;
  if (!transporter) {
    console.log("[EMAIL MOCK] reimbursement-available queued");
    return;
  }
  await transporter.sendMail({ messageId: params.messageId, from, to: params.to, subject, text, html });
}
