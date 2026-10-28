import { getEmailTransport } from "./transporter";
import { emailLayout } from "./brand";
import { BODY_STYLE, escapeHtml, greeting, headerText, HEADING_STYLE } from "./index";
import { emailButton } from "./team";

/** Application emails (docs/ADMISSION.md), in the Space Works email layout. */

export type AdmissionNoticeKind = "offer" | "reminder" | "expired" | "extended" | "waitlisted" | "rejected" | "stage-advanced";

type Copy = { subject: string; heading: string; lines: string[]; button: string };

function copyFor(notice: AdmissionNoticeKind, p: { eventTitle: string; respondBy?: string; stageName?: string; paid: boolean; teamName?: string }): Copy {
  const who = p.teamName ? `Your team, ${p.teamName},` : "You";
  const yours = p.teamName ? `your team's application` : "your application";
  const accept = p.paid ? "Accept and pay" : "Accept your place";
  switch (notice) {
    case "offer":
      return {
        subject: `You're offered a place · ${headerText(p.eventTitle)}`,
        heading: "You're offered a place",
        lines: [`${who} ${p.teamName ? "has" : "have"} been offered a place at ${p.eventTitle}.`, `${accept} by ${p.respondBy}, or the place goes to someone else.${p.paid ? " Your place is confirmed once it's paid for." : ""}`],
        button: p.paid ? "Accept and pay" : "Accept or decline",
      };
    case "reminder":
      return {
        subject: `Your offer ends soon · ${headerText(p.eventTitle)}`,
        heading: "Your offer ends soon",
        lines: [`The place offered for ${p.eventTitle} is waiting for an answer.`, `${accept} by ${p.respondBy}, or the place goes to someone else.`],
        button: "Answer the offer",
      };
    case "extended":
      return {
        subject: `More time to answer · ${headerText(p.eventTitle)}`,
        heading: "You have more time",
        lines: [`The organisers gave you until ${p.respondBy} to answer the offer of a place at ${p.eventTitle}.`],
        button: "Answer the offer",
      };
    case "expired":
      return {
        subject: `Your offer has ended · ${headerText(p.eventTitle)}`,
        heading: "Your offer has ended",
        lines: [`The offer of a place at ${p.eventTitle} wasn't accepted in time, so it has been given to someone else.`, "Get in touch with the organisers if you think this is a mistake."],
        button: "View your application",
      };
    case "waitlisted":
      return {
        subject: `You're on the waitlist · ${headerText(p.eventTitle)}`,
        heading: "You're on the waitlist",
        lines: [`Thanks for applying to ${p.eventTitle}. All places are offered for now, so ${yours} is on the waitlist.`, "We'll email you if a place opens up; places go in the order people joined the waitlist."],
        button: "View your application",
      };
    case "rejected":
      return {
        subject: `About your application · ${headerText(p.eventTitle)}`,
        heading: "Thank you for applying",
        lines: [`Thank you for applying to ${p.eventTitle}. We aren't able to offer ${p.teamName ? "your team" : "you"} a place this time.`, "Nothing was charged."],
        button: "View your application",
      };
    case "stage-advanced":
      return {
        subject: `Your application moved on · ${headerText(p.eventTitle)}`,
        heading: "Your application moved on",
        lines: [`Good news: ${yours} for ${p.eventTitle} has moved on to ${p.stageName ?? "the next stage"}.`, "There's nothing you need to do now; we'll email you when there's a decision."],
        button: "View your application",
      };
  }
}

export async function sendAdmissionNoticeEmail(params: {
  to: string;
  notice: AdmissionNoticeKind;
  eventTitle: string;
  /** The applicant's own ticket page, where they answer the offer (a bearer link). */
  applicationUrl: string;
  respondBy?: string;
  stageName?: string;
  paid: boolean;
  teamName?: string;
  recipientName?: string;
  messageId?: string;
}): Promise<void> {
  const { transporter, from } = await getEmailTransport();
  const copy = copyFor(params.notice, params);
  const salutation = greeting(params.recipientName);
  const html = emailLayout(escapeHtml(copy.subject), `
          <h2 style="${HEADING_STYLE}">${escapeHtml(copy.heading)}</h2>
          <p style="${BODY_STYLE}">${salutation.html}</p>
          ${copy.lines.map((line) => `<p style="${BODY_STYLE}">${escapeHtml(line)}</p>`).join("")}
          ${emailButton(params.applicationUrl, copy.button)}`);
  const text = `${copy.subject}\n\n${salutation.text}\n\n${copy.lines.join("\n\n")}\n\n${params.applicationUrl}\n\nBest regards,\nSpace Works Events`;
  if (!transporter) {
    console.log("[EMAIL MOCK] application notice queued");
    return;
  }
  await transporter.sendMail({ messageId: params.messageId, from, to: params.to, subject: copy.subject, text, html });
}
