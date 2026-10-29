import "server-only";

/** Queue email in the caller's transaction; the worker sends it (lib/outboxWorker.ts). */

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import type { CollaboratorInvitePayload, EmailVerificationPayload, EventBroadcastPayload, EventBroadcastTestPayload, EventInvitePayload, OperatorNoticePayload, PasswordResetPayload, RsvpConfirmationPayload, RsvpStatusPayload, SignInCodePayload } from "./payloads";

export type OutboxClient = Prisma.TransactionClient | typeof prisma;

export async function enqueueOperatorNotice(client: OutboxClient, payload: OperatorNoticePayload) {
  return client.outboxMessage.create({ data: { kind: "operator-notice", payload: payload as Prisma.InputJsonValue } });
}

export async function enqueueOperatorNotices(client: OutboxClient, payloads: OperatorNoticePayload[]) {
  if (payloads.length === 0) return { count: 0 };
  return client.outboxMessage.createMany({
    data: payloads.map((payload) => ({ kind: "operator-notice", payload: payload as Prisma.InputJsonValue })),
  });
}

export async function enqueueEventBroadcastRecipients(client: OutboxClient, recipients: EventBroadcastPayload[]) {
  if (recipients.length === 0) return { count: 0 };
  return client.outboxMessage.createMany({
    data: recipients.map((payload) => ({ kind: "event-broadcast", payload: payload as Prisma.InputJsonValue })),
  });
}

export async function enqueueEventBroadcastTest(client: OutboxClient, payload: EventBroadcastTestPayload) {
  return client.outboxMessage.create({ data: { kind: "event-broadcast-test", payload: payload as Prisma.InputJsonValue } });
}

export async function enqueueCollaboratorInvite(client: OutboxClient, payload: CollaboratorInvitePayload) { return client.outboxMessage.create({ data: { kind: "collaborator-invite", payload: payload as Prisma.InputJsonValue } }); }

export async function enqueueRsvpConfirmation(
  client: OutboxClient,
  payload: RsvpConfirmationPayload,
) {
  return client.outboxMessage.create({
    data: {
      kind: "rsvp-confirmation",
      payload: payload as Prisma.InputJsonValue,
    },
  });
}

export async function enqueueRsvpStatusNotification(
  client: OutboxClient,
  payload: RsvpStatusPayload,
) {
  return client.outboxMessage.create({
    data: {
      kind: "rsvp-status",
      payload: payload as Prisma.InputJsonValue,
    },
  });
}

export async function enqueueSignInCode(client: OutboxClient, payload: SignInCodePayload) {
  return client.outboxMessage.create({ data: { kind: "sign-in-code", payload: payload as Prisma.InputJsonValue } });
}

export async function enqueuePasswordReset(
  client: OutboxClient,
  payload: PasswordResetPayload,
) {
  return client.outboxMessage.create({
    data: {
      kind: "password-reset",
      payload: payload as Prisma.InputJsonValue,
    },
  });
}

export async function enqueueEventInvite(
  client: OutboxClient,
  payload: EventInvitePayload,
) {
  return client.outboxMessage.create({
    data: {
      kind: "event-invite",
      payload: payload as Prisma.InputJsonValue,
    },
  });
}

export async function enqueueEmailVerification(
  client: OutboxClient,
  payload: EmailVerificationPayload,
) {
  return client.outboxMessage.create({
    data: { kind: "email-verification", payload: payload as Prisma.InputJsonValue },
  });
}
