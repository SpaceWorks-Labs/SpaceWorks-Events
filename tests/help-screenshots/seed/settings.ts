import "./serverOnly";
import crypto from "node:crypto";
import { ChatChannelKind, IdFieldPlacement, IdFieldType, IdMemberSource, IdMemberStatus, IdProgrammeStatus, WebhookDeliveryStatus, type Event } from "@prisma/client";
import { encryptOrgSecret } from "@/lib/orgSecrets";
import { chatSecretSlot } from "@/lib/chat/notify";
import { encryptWebhookSecret } from "@/lib/webhooks/secrets";
import { encryptInstanceConfigSecret } from "@/lib/instanceConfigSecrets";
import { CLASSIC_DESIGN, STARTER_DESIGNS } from "@/lib/ticketDesign/presets";
import { defaultMemberIdDesign } from "@/lib/memberIds/design";
import { normalizeIdCardPrintSettings } from "@/lib/idCardPrint/normalize";
import { DAY, MINUTE, type Db } from "./common";
import type { People } from "./people";

/** Organisation integrations: sender, chat, webhooks and the machine API. Every address is fictional. */
export async function seedIntegrations(prisma: Db, people: People, now: number) {
  const { org, owner, admin } = people;
  await prisma.organisationEmailSettings.create({ data: { organisationId: org.id, fromName: "Riverside Tech Collective", replyTo: "hello@example.org" } });

  const channelId = `c${crypto.randomBytes(12).toString("hex")}`;
  await prisma.chatChannel.create({
    data: {
      id: channelId, organisationId: org.id, kind: ChatChannelKind.SLACK, name: "#events-team", events: ["registration", "request", "payment", "refund", "claim"],
      secretEncrypted: encryptOrgSecret(org.id, chatSecretSlot(channelId), JSON.stringify({ url: "https://hooks.slack.com/services/T00000000/B00000000/EXAMPLEexample0000" })),
      lastDeliveredAt: new Date(now - 50 * MINUTE),
    },
  });

  await prisma.apiClient.create({
    data: {
      organisationId: org.id, name: "Attendance sync",
      scopes: { create: [{ scope: "events:read" }, { scope: "participants:read" }, { scope: "participants:attendance:read" }] },
      credentials: { create: { name: "Production", secretHash: crypto.randomBytes(32), lastUsedAt: new Date(now - 3 * 60 * MINUTE), expiresAt: new Date(now + 180 * DAY) } },
    },
  });
  const secret = () => encryptWebhookSecret(`whsec_example_${crypto.randomBytes(12).toString("hex")}`);
  const crm = await prisma.webhookEndpoint.create({
    data: {
      organisationId: org.id, url: "https://hooks.example.org/spaceworks/registrations", description: "Members CRM", eventTypes: ["registration.created", "registration.status_changed"],
      secretEncrypted: secret(), lastSuccessAt: new Date(now - 40 * MINUTE), createdByUserId: owner.id,
    },
  });
  await prisma.webhookDelivery.create({
    data: {
      endpointId: crm.id, organisationId: org.id, eventId: `evt_${crypto.randomBytes(12).toString("hex")}`, eventType: "registration.created", payload: { type: "registration.created" },
      status: WebhookDeliveryStatus.SUCCEEDED, attempts: 1, lastAttemptAt: new Date(now - 40 * MINUTE), deliveredAt: new Date(now - 40 * MINUTE), lastStatusCode: 200, responseTimeMs: 182,
    },
  });
  await prisma.webhookEndpoint.create({
    data: {
      organisationId: org.id, url: "https://hooks.example.org/spaceworks/door-display", description: "Door display", eventTypes: ["checkin.created", "checkin.undone"],
      secretEncrypted: secret(), enabled: false, disabledReason: "auto_disabled", disabledAt: new Date(now - 2 * DAY), consecutiveFailures: 20,
      lastFailureAt: new Date(now - 2 * DAY), lastSuccessAt: new Date(now - 9 * DAY), createdByUserId: admin.id,
    },
  });
}

/** Ticket designs, the main event's badge design, and a member ID programme. */
export async function seedDesigns(prisma: Db, people: People, events: { main: Event; summit: Event }, now: number) {
  const { org, owner, buyer } = people;
  const library = [];
  for (const starter of STARTER_DESIGNS) {
    library.push(await prisma.ticketDesign.create({ data: { organisationId: org.id, name: starter.label, document: starter.document, updatedById: owner.id } }));
  }
  await prisma.organisation.update({ where: { id: org.id }, data: { defaultTicketDesignId: library[0]!.id } });
  const summitDesign = await prisma.ticketDesign.create({
    data: { organisationId: org.id, eventId: events.summit.id, name: "Summit ticket", document: { ...CLASSIC_DESIGN, background: "#F4F8FF" }, updatedById: owner.id },
  });
  await prisma.event.update({ where: { id: events.summit.id }, data: { ticketDesignId: summitDesign.id } });

  const badge = normalizeIdCardPrintSettings({}, events.main.title, org.name);
  await prisma.eventBadgeDesign.create({ data: { eventId: events.main.id, settings: badge, updatedById: owner.id } });

  const programmeName = "Riverside Members 2026";
  const programme = await prisma.idProgramme.create({
    data: {
      organisationId: org.id, name: programmeName, slug: "members-2026", description: "Membership cards for the Riverside Tech Collective, valid for the year.",
      status: IdProgrammeStatus.ACTIVE, registrationOpen: true, requiresApproval: true, idPrefix: "RTC", validUntil: new Date("2026-12-31T23:59:59Z"),
      design: defaultMemberIdDesign({ programmeName, organisationName: org.name }), createdAt: new Date(now - 30 * DAY),
      fields: {
        create: [
          { key: "membership", label: "Membership type", type: IdFieldType.SELECT, required: true, options: ["Regular", "Student", "Volunteer"], placement: IdFieldPlacement.FRONT, sortOrder: 0 },
          { key: "phone", label: "Phone", type: IdFieldType.PHONE, required: false, placement: IdFieldPlacement.HIDDEN, sortOrder: 1 },
        ],
      },
    },
  });
  const members = [
    { name: "Olu Adebayo", email: buyer.email!, userId: buyer.id, type: "Regular", status: IdMemberStatus.APPROVED, daysAgo: 25 },
    { name: "Amara Okeke", email: "amara.okeke@example.org", type: "Volunteer", status: IdMemberStatus.APPROVED, daysAgo: 22 },
    { name: "Bilal Hussain", email: "bilal.hussain@example.org", type: "Regular", status: IdMemberStatus.APPROVED, daysAgo: 18 },
    { name: "Carys Morgan", email: "carys.morgan@example.org", type: "Student", status: IdMemberStatus.APPROVED, daysAgo: 15 },
    { name: "Daniel Novak", email: "daniel.novak@example.org", type: "Regular", status: IdMemberStatus.PENDING, daysAgo: 2 },
    { name: "Elif Demir", email: "elif.demir@example.org", type: "Student", status: IdMemberStatus.PENDING, daysAgo: 1 },
    { name: "Finn O'Brien", email: "finn.obrien@example.org", type: "Regular", status: IdMemberStatus.PENDING, daysAgo: 0.5 },
  ];
  let sequence = 1;
  for (const member of members) {
    const approved = member.status === IdMemberStatus.APPROVED;
    const createdAt = new Date(now - member.daysAgo * DAY);
    await prisma.idMember.create({
      data: {
        programmeId: programme.id, organisationId: org.id, userId: member.userId ?? null, name: member.name, email: member.email, fieldValues: { membership: member.type },
        status: member.status, source: IdMemberSource.FORM, verifyToken: crypto.randomBytes(18).toString("base64url"), createdAt,
        ...(approved ? { idNumber: `RTC-2026-${String(sequence++).padStart(4, "0")}`, issuedAt: new Date(createdAt.getTime() + DAY), expiresAt: new Date("2026-12-31T23:59:59Z") } : {}),
      },
    });
  }
  await prisma.idProgramme.update({ where: { id: programme.id }, data: { nextSequence: sequence } });
  return { libraryDesignId: library[0]!.id, programmeId: programme.id };
}

/** Instance-wide settings for the super-admin pages. The alerts webhook is saved but off, so nothing is ever posted. */
export async function seedInstance(prisma: Db, people: People, now: number) {
  const values = {
    paidEventsEnabled: true,
    emailFrom: "Space Works Events <events@example.org>", smtpHost: "smtp.example.test", smtpPort: 587, smtpUser: "events",
    backupProvider: "Managed PostgreSQL snapshots", backupLastSuccessAt: new Date(now - 7 * 60 * MINUTE), backupRetentionDays: 30,
    opsWebhookUrlEncrypted: encryptInstanceConfigSecret("https://chat.example.org/hooks/exampleopsalerts"), opsWebhookEnabled: false,
  };
  await prisma.instanceSetting.upsert({ where: { id: "global" }, create: { id: "global", ...values }, update: values });
  const { org, owner, member2, superAdmin } = people;
  const audit = [
    ["ORGANISATION_INVITE_CREATED", owner.id, 5],
    ["ORGANISATION_INVITE_ACCEPTED", member2.id, 4],
    ["MEMBERSHIP_ROLE_CHANGED", owner.id, 4],
    ["API_CLIENT_CREATED", owner.id, 3],
    ["API_CREDENTIAL_CREATED", owner.id, 3],
    ["INSTANCE_SETTINGS_UPDATED", superAdmin.id, 1],
  ] as const;
  for (const [action, actorUserId, daysAgo] of audit) {
    await prisma.auditEvent.create({ data: { action, actorUserId, organisationId: org.id, createdAt: new Date(now - daysAgo * DAY) } });
  }
}
