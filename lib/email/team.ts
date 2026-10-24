import type { RsvpStatus } from "@prisma/client";
import { getEmailTransport } from "./transporter";
import { EMAIL_BUTTON_STYLE, EMAIL_COLORS, emailLayout } from "./brand";
import { BODY_STYLE, escapeHtml, getBaseUrl, greeting, headerText, HEADING_STYLE } from "./index";

function button(url: string, label: string) {
  const safeUrl = escapeHtml(url);
  return `<p style="margin:28px 0;"><a href="${safeUrl}" style="${EMAIL_BUTTON_STYLE}">${escapeHtml(label)}</a></p>
          <p style="font-size:13px; color:${EMAIL_COLORS.inkMuted}; overflow-wrap:anywhere;">${safeUrl}</p>`;
}

/**
 * Team page link for a team leader. The management link is a bearer
 * capability shown only here; the join link is safe to share with teammates.
 * Paths are site-relative and made absolute with NEXT_PUBLIC_BASE_URL.
 */
export async function sendTeamCreatedEmail(params: {
  to: string;
  eventTitle: string;
  teamName: string;
  managePath: string;
  joinPath: string;
  reason: "created" | "leader";
  recipientName?: string;
  messageId?: string;
}): Promise<void> {
  const { transporter, from } = await getEmailTransport();
  const manageUrl = `${getBaseUrl()}${params.managePath}`;
  const joinUrl = `${getBaseUrl()}${params.joinPath}`;
  const salutation = greeting(params.recipientName);
  const safeTeam = escapeHtml(params.teamName);
  const safeTitle = escapeHtml(params.eventTitle);
  const leader = params.reason === "leader";
  const subject = leader
    ? `You now lead ${headerText(params.teamName)} · ${headerText(params.eventTitle)}`
    : `Your team ${headerText(params.teamName)} · ${headerText(params.eventTitle)}`;
  const intro = leader
    ? `You are now the leader of team <strong>${safeTeam}</strong> for <strong>${safeTitle}</strong>.`
    : `Your team <strong>${safeTeam}</strong> is registered for <strong>${safeTitle}</strong>.`;
  const introText = leader
    ? `You are now the leader of team "${params.teamName}" for "${params.eventTitle}".`
    : `Your team "${params.teamName}" is registered for "${params.eventTitle}".`;
  const html = emailLayout(escapeHtml(subject), `
          <h2 style="${HEADING_STYLE}">Your team page</h2>
          <p style="${BODY_STYLE}">${salutation.html}<br><br>${intro}</p>
          <p style="${BODY_STYLE}">Use your private team page to add or remove members, rename the team and share the join link. Keep this link to yourself: anyone with it can manage the team.</p>
          ${button(manageUrl, "Manage your team")}
          <h3 style="margin:24px 0 8px; color:${EMAIL_COLORS.ink}; font-size:16px; font-weight:600;">Invite teammates</h3>
          <p style="${BODY_STYLE}">Share this join link with your teammates so they can register into your team:</p>
          <p style="font-size:13px; color:${EMAIL_COLORS.inkMuted}; overflow-wrap:anywhere;"><a href="${escapeHtml(joinUrl)}" style="color:${EMAIL_COLORS.teal};">${escapeHtml(joinUrl)}</a></p>`);
  const text = `${subject}\n\n${salutation.text}\n\n${introText}\n\nManage your team (keep this link private):\n${manageUrl}\n\nShare this join link with your teammates:\n${joinUrl}\n\nBest regards,\nSpace Works Events`;
  if (!transporter) {
    // The management link is a bearer capability; never log it.
    console.log("[EMAIL MOCK] team page link queued");
    return;
  }
  await transporter.sendMail({ messageId: params.messageId, from, to: params.to, subject, text, html });
}

/** A member the team leader added receives their own ticket link. */
export async function sendTeamMemberAddedEmail(params: {
  to: string;
  eventTitle: string;
  teamName: string;
  status: RsvpStatus;
  checkInToken: string;
  addedByName?: string;
  recipientName?: string;
  messageId?: string;
}): Promise<void> {
  const { transporter, from } = await getEmailTransport();
  const ticketUrl = `${getBaseUrl()}/ticket/${params.checkInToken}`;
  const salutation = greeting(params.recipientName);
  const addedBy = params.addedByName?.replace(/[\u0000-\u001F\u007F]+/g, " ").trim().slice(0, 200) || "";
  const subject = `You're on team ${headerText(params.teamName)} · ${headerText(params.eventTitle)}`;
  const statusLine = params.status === "CONFIRMED"
    ? "Your place is confirmed."
    : params.status === "WAITLISTED"
      ? "The team is on the waitlist for now. We will email you if it gets a place."
      : params.status === "PENDING_APPROVAL"
        ? "The team is waiting for organiser approval. We will email you once it's reviewed."
        : "";
  const who = addedBy ? `${escapeHtml(addedBy)} added you` : "Your team leader added you";
  const whoText = addedBy ? `${addedBy} added you` : "Your team leader added you";
  const html = emailLayout(escapeHtml(subject), `
          <h2 style="${HEADING_STYLE}">You're on the team</h2>
          <p style="${BODY_STYLE}">${salutation.html}<br><br>${who} to team <strong>${escapeHtml(params.teamName)}</strong> for <strong>${escapeHtml(params.eventTitle)}</strong>. ${statusLine}</p>
          <p style="${BODY_STYLE}">Your registration page shows your ticket and your team, and lets you leave the team if you can't make it.</p>
          ${button(ticketUrl, "View your registration")}`);
  const text = `${subject}\n\n${salutation.text}\n\n${whoText} to team "${params.teamName}" for "${params.eventTitle}". ${statusLine}\n\nView your registration: ${ticketUrl}\n\nBest regards,\nSpace Works Events`;
  if (!transporter) {
    console.log("[EMAIL MOCK] team member ticket queued");
    return;
  }
  await transporter.sendMail({ messageId: params.messageId, from, to: params.to, subject, text, html });
}
