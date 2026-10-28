import { z } from "zod";
import { mobileError, mobileOk, parseQuery } from "@/lib/mobile/http";
import { listMyOrders } from "@/lib/mobile/orders";
import { authedMobileRoute } from "@/lib/mobile/route";

const querySchema = z.object({ cursor: z.string().min(1).max(1024).optional() }).strict();

/** The signed-in buyer's orders, newest first (tickets, paid team places and entry fees). */
export const GET = authedMobileRoute("GET /api/mobile/v1/me/orders", async (request, _params, { auth }) => {
  const query = parseQuery(request, querySchema);
  if ("response" in query) return query.response;
  const result = await listMyOrders(auth.userId, query.data.cursor);
  return result ? mobileOk(result) : mobileError("INVALID_REQUEST", "Invalid cursor.");
});
