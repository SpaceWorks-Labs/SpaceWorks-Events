import { NextResponse } from "next/server";
import { withApiMonitoring } from "@/lib/apiMonitor";
import { handleMachineApiRequest } from "@/lib/api/v1/handler";
import { apiError } from "@/lib/api/v1/errors";
import { apiResourceIdSchema } from "@/lib/api/v1/schemas";
import { getApiApplicationCounts } from "@/lib/api/v1/applications";

type Context = { params: Promise<{ eventId: string }> };

/** Application counts for one event (`applications:read`, docs/API.md): numbers only, never applicants. */
export const GET = withApiMonitoring(
  "GET /api/v1/events/:eventId/applications",
  async (request: Request, routeContext: Context) =>
    handleMachineApiRequest(request, "applications:read", async (context) => {
      const params = await routeContext.params;
      const eventId = apiResourceIdSchema.safeParse(params.eventId);
      if (!eventId.success) return apiError("INVALID_REQUEST", 400);
      const response = await getApiApplicationCounts(context.organisationId, eventId.data);
      if (!response) return apiError("RESOURCE_NOT_FOUND", 404);
      return NextResponse.json(response, { headers: { "Cache-Control": "no-store" } });
    }),
);
