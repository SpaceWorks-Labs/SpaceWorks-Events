import "server-only";

import { AdmissionBatchStatus, AdmissionStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { offerCeiling } from "@/lib/admission/rules";
import { applicationCountsSchema, applicationsSummaryDtoSchema } from "@/lib/mobile/schemas";

/*
 * Application counts for /api/mobile/v1 (docs/ADMISSION.md): numbers only,
 * for viewers who manage applications (EventCounts.applications and
 * GET .../applications/summary). Never applicants, answers or reviews.
 */

type Counted = { total: number; byStatus: Record<AdmissionStatus, number>; offersOut: number; offersLimit: number | null };

/** Per event that takes applications; events that don't are left out. */
export async function loadApplicationCounts(eventIds: string[]): Promise<Map<string, Counted>> {
  const result = new Map<string, Counted>();
  if (eventIds.length === 0) return result;
  const events = await prisma.event.findMany({ where: { id: { in: eventIds }, admissionEnabled: true }, select: { id: true, capacity: true, admissionOfferCapacity: true } });
  if (events.length === 0) return result;
  const grouped = await prisma.admissionApplication.groupBy({ by: ["eventId", "status"], where: { eventId: { in: events.map((event) => event.id) } }, _count: { _all: true } });
  for (const event of events) {
    const byStatus = Object.fromEntries(Object.values(AdmissionStatus).map((status) => [status, grouped.find((row) => row.eventId === event.id && row.status === status)?._count._all ?? 0])) as Record<AdmissionStatus, number>;
    result.set(event.id, applicationCountsSchema.parse({
      total: Object.values(byStatus).reduce((sum, value) => sum + value, 0),
      byStatus,
      offersOut: byStatus.OFFERED + byStatus.ACCEPTED,
      offersLimit: offerCeiling(event),
    }));
  }
  return result;
}

export async function loadApplicationsSummary(eventId: string) {
  const event = await prisma.event.findUniqueOrThrow({ where: { id: eventId }, select: { admissionEnabled: true, admissionMode: true } });
  const [counts, stages, inReview, passedOver, drafted] = await Promise.all([
    loadApplicationCounts([eventId]),
    prisma.admissionStage.findMany({ where: { eventId }, orderBy: { position: "asc" }, select: { id: true, position: true, name: true, status: true, _count: { select: { entries: true } } } }),
    prisma.admissionApplication.groupBy({ by: ["currentStageId"], where: { eventId, status: AdmissionStatus.IN_REVIEW }, _count: { _all: true } }),
    prisma.admissionApplication.count({ where: { eventId, status: AdmissionStatus.WAITLISTED, skipReason: { not: null } } }),
    prisma.admissionDecision.count({ where: { batch: { eventId, status: AdmissionBatchStatus.DRAFT } } }),
  ]);
  const zero = { total: 0, byStatus: Object.fromEntries(Object.values(AdmissionStatus).map((status) => [status, 0])) as Record<AdmissionStatus, number>, offersOut: 0, offersLimit: null };
  const counted = counts.get(eventId) ?? zero;
  return applicationsSummaryDtoSchema.parse({
    enabled: event.admissionEnabled,
    mode: event.admissionMode,
    counts: counted,
    stages: stages.map((stage) => ({ position: stage.position, name: stage.name, status: stage.status, reached: stage._count.entries, inReview: inReview.find((row) => row.currentStageId === stage.id)?._count._all ?? 0 })),
    waitlist: { queued: counted.byStatus.WAITLISTED, passedOver },
    draftedDecisions: drafted,
  });
}
