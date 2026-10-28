import "server-only";

import { AdmissionStatus } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { offerCeiling } from "@/lib/admission/rules";

/*
 * `applications:read` (docs/API.md, docs/ADMISSION.md): an event's
 * applications as counts only, by status and by stage, and the offers out.
 * No applicant names, contact details, answers, reviews, scores or reviewers.
 */

const counts = z.object(Object.fromEntries(Object.values(AdmissionStatus).map((status) => [status, z.number().int().nonnegative()])) as Record<AdmissionStatus, z.ZodNumber>).strict();

export const applicationCountsResponseSchema = z.object({
  data: z.object({
    eventId: z.string(),
    enabled: z.boolean(),
    total: z.number().int().nonnegative(),
    byStatus: counts,
    stages: z.array(z.object({ position: z.number().int(), name: z.string(), status: z.enum(["DRAFT", "OPEN", "CLOSED"]), reached: z.number().int().nonnegative(), inReview: z.number().int().nonnegative() }).strict()),
    offers: z.object({ out: z.number().int().nonnegative(), limit: z.number().int().nullable() }).strict(),
  }).strict(),
}).strict();

export async function getApiApplicationCounts(organisationId: string, eventId: string) {
  const event = await prisma.event.findFirst({ where: { id: eventId, organisationId }, select: { id: true, admissionEnabled: true, admissionOfferCapacity: true, capacity: true } });
  if (!event) return null;
  const [grouped, stages, inReview] = await Promise.all([
    prisma.admissionApplication.groupBy({ by: ["status"], where: { eventId: event.id }, _count: { _all: true } }),
    prisma.admissionStage.findMany({ where: { eventId: event.id }, orderBy: { position: "asc" }, select: { id: true, position: true, name: true, status: true, _count: { select: { entries: true } } } }),
    prisma.admissionApplication.groupBy({ by: ["currentStageId"], where: { eventId: event.id, status: AdmissionStatus.IN_REVIEW }, _count: { _all: true } }),
  ]);
  const byStatus = Object.fromEntries(Object.values(AdmissionStatus).map((status) => [status, grouped.find((row) => row.status === status)?._count._all ?? 0])) as Record<AdmissionStatus, number>;
  return applicationCountsResponseSchema.parse({
    data: {
      eventId: event.id,
      enabled: event.admissionEnabled,
      total: Object.values(byStatus).reduce((sum, value) => sum + value, 0),
      byStatus,
      stages: stages.map((stage) => ({ position: stage.position, name: stage.name, status: stage.status, reached: stage._count.entries, inReview: inReview.find((row) => row.currentStageId === stage.id)?._count._all ?? 0 })),
      offers: { out: byStatus.OFFERED + byStatus.ACCEPTED, limit: offerCeiling(event) },
    },
  });
}
