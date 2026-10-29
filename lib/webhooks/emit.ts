import "server-only";

import crypto from "node:crypto";
import { outsideRequestActor } from "@/lib/requestActor";
import type { AdmissionStatus, EventStatus, ExpenseClaimStatus, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import {
  buildWebhookEnvelope,
  webhookEventRef,
  webhookRegistration,
  type EventRefSource,
  type RegistrationWebhookStatus,
  type WebhookDataType,
} from "@/lib/webhooks/payloads";
import type { WebhookEventType } from "@/lib/webhooks/eventTypes";

/**
 * Commit-point emission for organisation webhooks.
 *
 * Callers invoke `emitWebhookEvent` only after their transaction has
 * committed. It returns immediately: loading the minimal payload, finding the
 * subscribed endpoints and inserting the delivery rows all happen in the
 * background and never throw, so a webhook can never fail or slow the action
 * that raised it. Delivery itself is the worker's job (lib/webhooks/delivery.ts).
 */

/** The fields of a registration that may be gone by the time the payload is built (cancel, remove). */
export type RsvpWebhookSnapshot = {
  id: string;
  eventId: string | null;
  eventInstanceId: string | null;
  userId: string | null;
  guestName: string | null;
  createdAt: Date;
  checkedInAt: Date | null;
  /** A crew ticket (docs/CREW.md); absent means not crew. */
  isCrew?: boolean;
};

export type WebhookEmission =
  | { type: "registration.created"; rsvpId: string }
  | {
      type: "registration.status_changed";
      rsvpId: string;
      status: RegistrationWebhookStatus;
      previousStatus: RegistrationWebhookStatus | null;
      /** Required when the RSVP row has been deleted (cancelled or removed). */
      snapshot?: RsvpWebhookSnapshot;
    }
  | { type: "checkin.created"; rsvpId: string; checkedInAt: Date }
  | { type: "checkin.undone"; rsvpId: string; undoneAt: Date }
  | { type: "event.published" | "event.cancelled"; eventId: string; previousStatus: EventStatus | null }
  | { type: "feedback.submitted"; feedbackResponseId: string }
  | { type: "application.status_changed"; applicationId: string; status: AdmissionStatus; previousStatus: AdmissionStatus | null; /** The stage at the change (AdmissionStatusEvent.stageId). */ stageId?: string | null }
  /** The committed transition; the payload carries ids and amounts only. */
  | { type: "expense_claim.status_changed"; claimId: string; status: ExpenseClaimStatus; previousStatus: ExpenseClaimStatus | null };

const PENDING_KEY = Symbol.for("spaceworks.webhooks.pendingEmits");

function pendingEmits() {
  const g = globalThis as typeof globalThis & { [PENDING_KEY]?: Set<Promise<void>> };
  g[PENDING_KEY] ??= new Set();
  return g[PENDING_KEY];
}

export function newWebhookEventId() {
  return `evt_${crypto.randomBytes(16).toString("hex")}`;
}

/** Fire and forget. Safe to call from any commit point; never throws. */
export function emitWebhookEvent(emission: WebhookEmission) {
  // A registration change may have moved its application too (a settled
  // payment, a cancelled ticket): send the recorded application changes as well.
  if (emission.type === "registration.status_changed") track(() => import("@/lib/admission/statusEvents").then((module) => module.drainApplicationEvents()).then(() => undefined));
  track(() => enqueueWebhookEvent(emission).then(() => undefined), emission.type);
}

function track(work: () => Promise<void>, type = "application.status_changed") {
  const pending = pendingEmits();
  // Queued in the background, never as the request's actor.
  const task = outsideRequestActor(work)
    .catch(() => {
      // Category only: payload loading touches attendee names.
      console.warn(`[webhooks] could not queue ${type}`);
    })
    .finally(() => {
      pending.delete(task);
    });
  pending.add(task);
}

/** Waits for background emissions started so far (tests and graceful shutdown). */
export async function flushWebhookEmits() {
  while (pendingEmits().size > 0) await Promise.allSettled([...pendingEmits()]);
}

const eventRefSelect = {
  id: true,
  title: true,
  slug: true,
  startDateTime: true,
  endDateTime: true,
  timezone: true,
  organisation: { select: { id: true, slug: true } },
} as const;

const instanceRefSelect = {
  id: true,
  startDateTime: true,
  endDateTime: true,
  series: { select: { id: true, title: true, slug: true, timezone: true, organisation: { select: { id: true, slug: true } } } },
} as const;

type Built = { organisation: { id: string; slug: string }; data: unknown };

async function loadTarget(target: { eventId: string | null; eventInstanceId: string | null }) {
  if (target.eventId) {
    const event = await prisma.event.findUnique({ where: { id: target.eventId }, select: eventRefSelect });
    if (!event) return null;
    return { organisation: event.organisation, ref: webhookEventRef({ kind: "event", event }) };
  }
  if (target.eventInstanceId) {
    const instance = await prisma.eventInstance.findUnique({ where: { id: target.eventInstanceId }, select: instanceRefSelect });
    if (!instance) return null;
    const source: EventRefSource = { kind: "series_occurrence", instance, series: instance.series };
    return { organisation: instance.series.organisation, ref: webhookEventRef(source) };
  }
  return null;
}

const rsvpSelect = {
  id: true,
  eventId: true,
  eventInstanceId: true,
  guestName: true,
  createdAt: true,
  checkedInAt: true,
  status: true,
  isCrew: true,
  user: { select: { name: true } },
} as const;

async function loadRegistration(rsvpId: string, snapshot?: RsvpWebhookSnapshot) {
  if (snapshot) {
    const [target, user] = await Promise.all([
      loadTarget(snapshot),
      snapshot.userId ? prisma.user.findUnique({ where: { id: snapshot.userId }, select: { name: true } }) : null,
    ]);
    return target ? { target, rsvp: { ...snapshot, user }, currentStatus: null } : null;
  }
  const rsvp = await prisma.rSVP.findUnique({ where: { id: rsvpId }, select: rsvpSelect });
  if (!rsvp) return null;
  const target = await loadTarget(rsvp);
  return target ? { target, rsvp, currentStatus: rsvp.status } : null;
}

async function buildData(emission: WebhookEmission): Promise<Built | null> {
  switch (emission.type) {
    case "registration.created": {
      const loaded = await loadRegistration(emission.rsvpId);
      if (!loaded?.currentStatus) return null;
      return {
        organisation: loaded.target.organisation,
        data: { event: loaded.target.ref, registration: webhookRegistration(loaded.rsvp, loaded.currentStatus) },
      };
    }
    case "registration.status_changed": {
      const loaded = await loadRegistration(emission.rsvpId, emission.snapshot);
      if (!loaded) return null;
      return {
        organisation: loaded.target.organisation,
        data: {
          event: loaded.target.ref,
          // The committed transition, not a later re-read.
          registration: webhookRegistration(loaded.rsvp, emission.status),
          previousStatus: emission.previousStatus,
        },
      };
    }
    case "checkin.created":
    case "checkin.undone": {
      const loaded = await loadRegistration(emission.rsvpId);
      if (!loaded?.currentStatus) return null;
      const registration = webhookRegistration(loaded.rsvp, loaded.currentStatus);
      return {
        organisation: loaded.target.organisation,
        data: emission.type === "checkin.created"
          ? { event: loaded.target.ref, registration, checkedInAt: emission.checkedInAt.toISOString() }
          : { event: loaded.target.ref, registration, undoneAt: emission.undoneAt.toISOString() },
      };
    }
    case "event.published":
    case "event.cancelled": {
      const event = await prisma.event.findUnique({ where: { id: emission.eventId }, select: { ...eventRefSelect, status: true } });
      if (!event) return null;
      return {
        organisation: event.organisation,
        data: { event: { ...webhookEventRef({ kind: "event", event }), status: event.status }, previousStatus: emission.previousStatus },
      };
    }
    case "application.status_changed": {
      const application = await prisma.admissionApplication.findUnique({
        where: { id: emission.applicationId },
        select: { id: true, eventId: true, rsvpId: true, teamId: true, team: { select: { leaderRsvpId: true } }, currentStage: { select: { id: true, position: true, name: true } }, event: { select: eventRefSelect } },
      });
      if (!application) return null;
      // The stage recorded with the change, not wherever the application is now.
      const stage = emission.stageId === undefined
        ? application.currentStage
        : emission.stageId ? await prisma.admissionStage.findFirst({ where: { id: emission.stageId, eventId: application.eventId }, select: { id: true, position: true, name: true } }) : null;
      return {
        organisation: application.event.organisation,
        data: {
          event: webhookEventRef({ kind: "event", event: application.event }),
          application: {
            id: application.id,
            registrationId: application.rsvpId ?? application.team?.leaderRsvpId ?? null,
            teamId: application.teamId,
            // The committed transition, not a later re-read.
            status: emission.status,
            stage,
          },
          previousStatus: emission.previousStatus,
        },
      };
    }
    case "feedback.submitted": {
      const response = await prisma.eventFeedbackResponse.findUnique({
        where: { id: emission.feedbackResponseId },
        select: { id: true, submittedAt: true, form: { select: { event: { select: eventRefSelect } } } },
      });
      if (!response) return null;
      const event = response.form.event;
      return {
        organisation: event.organisation,
        data: { event: webhookEventRef({ kind: "event", event }), feedback: { id: response.id, submittedAt: response.submittedAt.toISOString() } },
      };
    }
    case "expense_claim.status_changed": {
      const claim = await prisma.expenseClaim.findUnique({
        where: { id: emission.claimId },
        select: { id: true, kind: true, category: true, amountMinor: true, approvedMinor: true, currency: true, rsvpId: true, policyId: true, event: { select: eventRefSelect } },
      });
      if (!claim?.event) return null;
      const { event, amountMinor, approvedMinor, ...rest } = claim;
      return {
        organisation: event.organisation,
        data: {
          event: webhookEventRef({ kind: "event", event }),
          claim: { id: rest.id, kind: rest.kind, status: emission.status, category: rest.category, amountMinor: Number(amountMinor), approvedMinor: approvedMinor == null ? null : Number(approvedMinor), currency: rest.currency, registrationId: rest.rsvpId, policyId: rest.policyId },
          previousStatus: emission.previousStatus,
        },
      };
    }
  }
}

/**
 * Builds the payload and inserts one delivery row per subscribed, enabled
 * endpoint. With `client` the endpoints are read and the deliveries inserted
 * in the caller's transaction; a stable `eventId` makes a repeat a no-op (one
 * delivery per endpoint and event id).
 */
export async function enqueueWebhookEvent(emission: WebhookEmission, options: { client?: Prisma.TransactionClient; eventId?: string } = {}) {
  const type: WebhookEventType = emission.type;
  const db = options.client ?? prisma;
  // Most instances have few endpoints: skip loading a payload nobody subscribed to.
  const anySubscribed = await db.webhookEndpoint.findFirst({ where: { enabled: true, eventTypes: { has: type } }, select: { id: true } });
  if (!anySubscribed) return 0;
  const built = await buildData(emission);
  if (!built) return 0;
  const endpoints = await db.webhookEndpoint.findMany({
    where: { organisationId: built.organisation.id, enabled: true, eventTypes: { has: type } },
    select: { id: true },
  });
  if (endpoints.length === 0) return 0;
  const envelope = buildWebhookEnvelope({
    id: options.eventId ?? newWebhookEventId(),
    type,
    createdAt: new Date(),
    organisation: built.organisation,
    data: built.data,
  });
  const result = await db.webhookDelivery.createMany({
    data: endpoints.map((endpoint) => ({
      endpointId: endpoint.id,
      organisationId: built.organisation.id,
      eventId: envelope.id,
      eventType: type,
      payload: envelope as Prisma.InputJsonValue,
    })),
    skipDuplicates: true,
  });
  return result.count;
}

/** Inserts a `ping` for one endpoint (Send test). Returns the delivery id. */
export async function enqueueWebhookPing(endpoint: { id: string; organisation: { id: string; slug: string } }) {
  const envelope = buildWebhookEnvelope({
    id: newWebhookEventId(),
    type: "ping" satisfies WebhookDataType,
    createdAt: new Date(),
    organisation: endpoint.organisation,
    data: { endpointId: endpoint.id, message: "This is a test event from Space Works Events." },
  });
  const row = await prisma.webhookDelivery.create({
    data: {
      endpointId: endpoint.id,
      organisationId: endpoint.organisation.id,
      eventId: envelope.id,
      eventType: "ping",
      payload: envelope as Prisma.InputJsonValue,
    },
    select: { id: true },
  });
  return row.id;
}

