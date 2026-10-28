import { revalidatePath } from "next/cache";
import { setJudgeRecusal } from "@/lib/core/judging";
import type { JudgeContext } from "@/lib/judgingAccess";
import { mobileActionError, mobileOk } from "@/lib/mobile/http";
import { judgingRoute } from "@/lib/mobile/judging";

type Params = { orgSlug: string; eventId: string; submissionId: string };

/*
 * Judge self-recusal (docs/HACKATHON.md "Recusal"), as the web "Recuse
 * myself": POST recuses from an assigned project in the open round, DELETE
 * undoes it. Both are idempotent. Refusals: JUDGING_CLOSED, NOT_VISIBLE (not
 * assigned to this judge in the open round), and CONFLICT once their review
 * of it is submitted.
 */
async function recusal(judge: JudgeContext, submissionId: string, recused: boolean) {
  const result = await setJudgeRecusal(judge, { submissionId }, recused);
  if (!result.ok) return mobileActionError(result);
  revalidatePath(`/dashboard/${judge.orgSlug}/event/${judge.eventId}`);
  return mobileOk(null);
}

export const POST = judgingRoute<Params>("POST /api/mobile/v1/orgs/:orgSlug/events/:eventId/judging/submissions/:submissionId/recusal", "action", async (_request, { submissionId }, { judge }) =>
  recusal(judge, submissionId, true));

export const DELETE = judgingRoute<Params>("DELETE /api/mobile/v1/orgs/:orgSlug/events/:eventId/judging/submissions/:submissionId/recusal", "action", async (_request, { submissionId }, { judge }) =>
  recusal(judge, submissionId, false));
