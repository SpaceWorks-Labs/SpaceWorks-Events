import "server-only";

import { MembershipRole, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { getBroadcastBaseUrl } from "@/lib/eventBroadcast";
import { enqueueOperatorNotice, enqueueOperatorNotices } from "@/lib/outbox";
import { notifyChat } from "@/lib/chat/notify";
import { noticeSubject, shorten } from "@/lib/noticeText";

export { noticeSubject, shorten, titleWith, whenLabel } from "@/lib/noticeText";

type Client = Prisma.TransactionClient | typeof prisma;

/** A registration's email address: the account's, else the guest's. */
export function personEmail(rsvp: { guestEmail: string | null; user?: { email: string | null; } | null; }) {
  return rsvp.user?.email?.trim() || rsvp.guestEmail?.trim() || null;
}

export function uniqueEmails(values: Array<string | null | undefined>) {
  return [...new Set(values.map((value) => value?.trim().toLowerCase()).filter((value): value is string => Boolean(value)))];
}

/** The same short plain notice to each address (no links that grant access). */
export async function noticeEach(client: Client, emails: string[], notice: { subject: string; lines: string[]; organisationId?: string; }) {
  for (const to of emails) {
    await enqueueOperatorNotice(client, {
      to, subject: shorten(notice.subject), lines: notice.lines.slice(0, 10).map((line) => shorten(line, 1000)),
      ...(notice.organisationId ? { organisationId: notice.organisationId } : {}),
    });
  }
  return emails.length;
}

/** Queue a date's recipients together while cancellation holds the target locks. */
export async function noticeMany(client: Client, emails: string[], notice: { subject: string; lines: string[]; organisationId?: string; }) {
  const payload = {
    subject: shorten(notice.subject), lines: notice.lines.slice(0, 10).map((line) => shorten(line, 1000)),
    ...(notice.organisationId ? { organisationId: notice.organisationId } : {}),
  };
  return (await enqueueOperatorNotices(client, emails.map((to) => ({ ...payload, to })))).count;
}

/** Owners and admins with a verified address: who hears about requests and failed refunds. */
export async function organiserEmails(client: Client, organisationId: string) {
  const members = await client.membership.findMany({
    where: { organisationId, role: { in: [MembershipRole.OWNER, MembershipRole.ADMIN] }, user: { email: { not: null }, emailVerified: { not: null } } },
    orderBy: { createdAt: "asc" },
    select: { user: { select: { email: true } } },
    take: 10,
  });
  return uniqueEmails(members.map((member) => member.user.email));
}

/**
 * A notice to organisers that repeats at most once per `withinMs` for the
 * same subject, so a busy event sends one email rather than one per guest.
 */
export async function noticeOrganisersOnce(client: Client, organisationId: string, notice: { subject: string; lines: string[]; }, withinMs = 30 * 60_000) {
  const subject = shorten(notice.subject);
  const since = new Date(Date.now() - withinMs);
  const due: string[] = [];
  for (const to of await organiserEmails(client, organisationId)) {
    const recent = await client.outboxMessage.count({
      where: { kind: "operator-notice", createdAt: { gte: since }, AND: [{ payload: { path: ["subject"], equals: subject } }, { payload: { path: ["to"], equals: to } }] },
    });
    if (recent === 0) due.push(to);
  }
  return noticeEach(client, due, { ...notice, subject, organisationId });
}

/** Someone asked to join an approval-only event or date: its organisers hear, at most every half hour. */
export async function noticeOrganisersOfRequest(client: Client, target: { eventId: string; } | { eventInstanceId: string; }) {
  const owner = "eventId" in target
    ? await client.event.findUnique({ where: { id: target.eventId }, select: { id: true, title: true, organisationId: true, organisation: { select: { slug: true } } } })
        .then((event) => event && { title: event.title, organisationId: event.organisationId, path: `/dashboard/${event.organisation.slug}/event/${event.id}` })
    : await client.eventInstance.findUnique({ where: { id: target.eventInstanceId }, select: { series: { select: { id: true, title: true, organisationId: true, organisation: { select: { slug: true } } } } } })
        .then((date) => date && { title: date.series.title, organisationId: date.series.organisationId, path: `/dashboard/${date.series.organisation.slug}/series/${date.series.id}` });
  if (!owner) return 0;
  await notifyChat(client, owner.organisationId, "request", `New request to join ${owner.title}. Review it in the guest list: ${getBroadcastBaseUrl()}${owner.path}`);
  return noticeOrganisersOnce(client, owner.organisationId, {
    subject: noticeSubject("New requests", owner.title),
    lines: [
      `People have asked to join ${owner.title}. They're waiting for you to accept or decline.`,
      `Review them in the guest list: ${getBroadcastBaseUrl()}${owner.path}`,
    ],
  });
}
