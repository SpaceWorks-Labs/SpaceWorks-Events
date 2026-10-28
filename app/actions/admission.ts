"use server";

import { applicationDetail } from "@/lib/admission/dashboard";
import { applyAssignment, assignReviewer, previewAssignment, unassignReviewer, type AssignPreview } from "@/lib/admission/assignment";
import { cancelDraftBatch, draftDecisions, releaseDraftBatch, removeDraftDecisions } from "@/lib/admission/decisions";
import { extendOffer, respondForApplicant } from "@/lib/admission/respond";
import { setAdmissionEnabled, updateAdmissionSettings } from "@/lib/admission/settings";
import { createStage, deleteStage, setStagePanel, updateStage } from "@/lib/admission/stages";
import type { ActionResult } from "./org";
import { done, organiserGate } from "./admission/gate";
import {
  applicationRefSchema,
  applicationsSchema,
  assignmentRefSchema,
  assignSchema,
  createStageSchema,
  draftSchema,
  enabledSchema,
  eventScope,
  extendSchema,
  manualAssignSchema,
  onBehalfSchema,
  panelSchema,
  settingsSchema,
  stageRefSchema,
  updateStageSchema,
} from "./admission/schemas";

/*
 * Organiser actions for applications (docs/ADMISSION.md). Each one checks the
 * session, the rate limit and the input, resolves the organisation and event
 * on the server (owner/admin or MANAGE_REGISTRATIONS, behind staff MFA), and
 * leaves every rule to lib/admission.
 */

const toDate = (value: string | null) => (value ? new Date(value) : null);

export async function setApplicationsEnabled(input: unknown): Promise<ActionResult> {
  const gate = await organiserGate(enabledSchema, input);
  return gate.ok ? done(gate.ctx, await setAdmissionEnabled(gate.ctx, gate.data.enabled)) : gate;
}

export async function saveApplicationSettings(input: unknown): Promise<ActionResult> {
  const gate = await organiserGate(settingsSchema, input);
  if (!gate.ok) return gate;
  const { mode, rsvpDays, offerCapacity, emailOnStageAdvance } = gate.data;
  return done(gate.ctx, await updateAdmissionSettings(gate.ctx, { mode, rsvpDays, offerCapacity, emailOnStageAdvance }));
}

export async function createApplicationStage(input: unknown): Promise<ActionResult<{ id: string }>> {
  const gate = await organiserGate(createStageSchema, input);
  if (!gate.ok) return gate;
  const { stage } = gate.data;
  return done(gate.ctx, await createStage(gate.ctx, { ...stage, opensAt: toDate(stage.opensAt), closesAt: toDate(stage.closesAt) }));
}

export async function updateApplicationStage(input: unknown): Promise<ActionResult> {
  const gate = await organiserGate(updateStageSchema, input);
  if (!gate.ok) return gate;
  const { stage, stageId, status } = gate.data;
  return done(gate.ctx, await updateStage(gate.ctx, stageId, { ...stage, status, opensAt: toDate(stage.opensAt), closesAt: toDate(stage.closesAt) }));
}

export async function deleteApplicationStage(input: unknown): Promise<ActionResult> {
  const gate = await organiserGate(stageRefSchema, input);
  return gate.ok ? done(gate.ctx, await deleteStage(gate.ctx, gate.data.stageId)) : gate;
}

export async function setApplicationStagePanel(input: unknown): Promise<ActionResult<{ panel: number }>> {
  const gate = await organiserGate(panelSchema, input);
  return gate.ok ? done(gate.ctx, await setStagePanel(gate.ctx, gate.data.stageId, gate.data.userIds)) : gate;
}

export async function previewReviewerAssignment(input: unknown): Promise<ActionResult<AssignPreview>> {
  const gate = await organiserGate(assignSchema, input);
  if (!gate.ok) return gate;
  const result = await previewAssignment(gate.ctx, gate.data);
  return result.ok ? { ok: true, data: result.data } : result;
}

export async function applyReviewerAssignment(input: unknown): Promise<ActionResult<{ added: number; removed: number; runId: string; seed: string | null }>> {
  const gate = await organiserGate(assignSchema, input);
  return gate.ok ? done(gate.ctx, await applyAssignment(gate.ctx, gate.data)) : gate;
}

export async function assignApplicationReviewer(input: unknown): Promise<ActionResult> {
  const gate = await organiserGate(manualAssignSchema, input);
  return gate.ok ? done(gate.ctx, await assignReviewer(gate.ctx, gate.data)) : gate;
}

export async function unassignApplicationReviewer(input: unknown): Promise<ActionResult> {
  const gate = await organiserGate(assignmentRefSchema, input);
  return gate.ok ? done(gate.ctx, await unassignReviewer(gate.ctx, gate.data.assignmentId)) : gate;
}

export async function draftApplicationDecisions(input: unknown): Promise<ActionResult<{ drafted: number }>> {
  const gate = await organiserGate(draftSchema, input);
  return gate.ok ? done(gate.ctx, await draftDecisions(gate.ctx, gate.data)) : gate;
}

export async function removeApplicationDecisions(input: unknown): Promise<ActionResult<{ removed: number }>> {
  const gate = await organiserGate(applicationsSchema, input);
  return gate.ok ? done(gate.ctx, await removeDraftDecisions(gate.ctx, gate.data.applicationIds)) : gate;
}

export async function cancelApplicationDecisions(input: unknown): Promise<ActionResult> {
  const gate = await organiserGate(eventScope.strict(), input);
  return gate.ok ? done(gate.ctx, await cancelDraftBatch(gate.ctx)) : gate;
}

export async function releaseApplicationDecisions(input: unknown): Promise<ActionResult<Record<string, number>>> {
  const gate = await organiserGate(eventScope.strict(), input);
  return gate.ok ? done(gate.ctx, await releaseDraftBatch(gate.ctx)) : gate;
}

export async function extendApplicationOffer(input: unknown): Promise<ActionResult> {
  const gate = await organiserGate(extendSchema, input);
  return gate.ok ? done(gate.ctx, await extendOffer(gate.ctx, gate.data.applicationId, new Date(gate.data.respondBy))) : gate;
}

export async function respondForApplication(input: unknown): Promise<ActionResult> {
  const gate = await organiserGate(onBehalfSchema, input);
  if (!gate.ok) return gate;
  const result = await respondForApplicant(gate.ctx, gate.data.applicationId, gate.data.response);
  return done(gate.ctx, result.ok ? { ok: true } : result);
}

export async function loadApplicationDetail(input: unknown): Promise<ActionResult<NonNullable<Awaited<ReturnType<typeof applicationDetail>>>>> {
  const gate = await organiserGate(applicationRefSchema, input);
  if (!gate.ok) return gate;
  const detail = await applicationDetail(gate.ctx, gate.data.applicationId);
  return detail ? { ok: true, data: detail } : { ok: false, error: "Application not found." };
}
