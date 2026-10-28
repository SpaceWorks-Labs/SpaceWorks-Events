import { AdmissionStatus } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn().mockResolvedValue(null) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/db";
import { getApiApplicationCounts } from "@/lib/api/v1/applications";
import { flushWebhookEmits } from "@/lib/webhooks/emit";
import { asAdmissionNoticePayload } from "@/lib/outbox/admission";
import { updateAdmissionSettings } from "@/lib/admission/settings";
import { apply, createAdmissionEvent, decide, noticesFor, paid, setUpAdmission, tearDownAdmission } from "./helpers/admission";

/*
 * What leaves the app about applications (docs/ADMISSION.md, docs/WEBHOOKS.md,
 * docs/API.md): the application.status_changed webhook carries ids, status
 * and stage only; the machine API returns counts only; application emails
 * carry ids only (the ticket link is added at send time), and the stage email
 * is sent only when the organiser turned it on.
 */

beforeAll(() => setUpAdmission("Application outputs"));
afterAll(() => tearDownAdmission());

describe.sequential("application outputs", () => {
  it("sends application.status_changed with ids, status and stage only", async () => {
    const { event, ctx } = await createAdmissionEvent();
    await prisma.eventRegistrationForm.create({ data: { eventId: event.id, fields: { create: [{ key: "secret", label: "Something private", type: "TEXT" }] } } });
    const endpoint = await prisma.webhookEndpoint.create({ data: { organisationId: paid.organisationId, url: "https://example.org/hook", eventTypes: ["application.status_changed"], secretEncrypted: "x" } });
    const a = await apply(event, "hooked");
    await prisma.rsvpAnswer.create({ data: { rsvpId: a.rsvp.id, fieldId: (await prisma.eventRegistrationField.findFirstOrThrow({ where: { form: { eventId: event.id } } })).id, valueText: "do-not-leak" } });
    await decide(ctx, [a.application.id], "ACCEPT");
    await flushWebhookEmits();
    const delivery = await prisma.webhookDelivery.findFirstOrThrow({ where: { endpointId: endpoint.id, eventType: "application.status_changed" } });
    const data = (delivery.payload as { data: Record<string, unknown> }).data;
    expect(data).toMatchObject({ application: { id: a.application.id, registrationId: a.rsvp.id, teamId: null, status: AdmissionStatus.OFFERED, stage: { position: 1, name: "Review" } }, previousStatus: AdmissionStatus.IN_REVIEW });
    const text = JSON.stringify(delivery.payload);
    expect(text).not.toContain("do-not-leak");
    expect(text).not.toContain(a.email);
    expect(text).not.toContain(a.token);
  });

  it("counts applications for the machine API, inside the credential's organisation only", async () => {
    const { event, ctx } = await createAdmissionEvent({ capacity: 10 });
    const a = await apply(event, "count-a");
    await apply(event, "count-b");
    await decide(ctx, [a.application.id], "ACCEPT");
    const counts = await getApiApplicationCounts(paid.organisationId, event.id);
    expect(counts?.data).toMatchObject({ enabled: true, total: 2, byStatus: { IN_REVIEW: 1, OFFERED: 1 }, offers: { out: 1, limit: 10 }, stages: [{ position: 1, reached: 2, inReview: 1 }] });
    expect(JSON.stringify(counts)).not.toContain("count-a");
    const other = await prisma.organisation.create({ data: { name: "Elsewhere", slug: `elsewhere-${paid.suffix}` } });
    try {
      expect(await getApiApplicationCounts(other.id, event.id)).toBeNull();
    } finally {
      await prisma.organisation.delete({ where: { id: other.id } });
    }
  });

  it("emails stage moves only when the organiser turned that on, and never puts capabilities in the payload", async () => {
    const { event, ctx } = await createAdmissionEvent();
    await prisma.admissionStage.create({ data: { eventId: event.id, position: 2, name: "Interview" } });
    const a = await apply(event, "quiet");
    const b = await apply(event, "told");
    await decide(ctx, [a.application.id], "ADVANCE");
    expect(await noticesFor(a.application.id, "stage-advanced")).toBe(0);
    expect(await updateAdmissionSettings(ctx, { mode: "MANUAL", rsvpDays: 7, offerCapacity: null, emailOnStageAdvance: true })).toEqual({ ok: true });
    await decide(ctx, [b.application.id], "ADVANCE");
    expect(await noticesFor(b.application.id, "stage-advanced")).toBe(1);
    const message = await prisma.outboxMessage.findFirstOrThrow({ where: { kind: "admission-notice", payload: { path: ["applicationId"], equals: b.application.id } } });
    expect(asAdmissionNoticePayload(message.payload)).not.toBeNull();
    expect(JSON.stringify(message.payload)).not.toContain(b.token);
  });
});
