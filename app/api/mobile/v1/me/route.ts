import { z } from "zod";
import { prisma } from "@/lib/db";
import { updateAccountProfileForUser } from "@/lib/core/accountProfile";
import { loadMe } from "@/lib/mobile/account";
import { mobileUserSelect, toUserDto } from "@/lib/mobile/dto";
import { mobileActionError, mobileOk, parseJsonBody } from "@/lib/mobile/http";
import { authedMobileRoute } from "@/lib/mobile/route";
import { userDtoSchema } from "@/lib/mobile/schemas";

export const GET = authedMobileRoute("GET /api/mobile/v1/me", async (_request, _params, { auth, baseUrl }) =>
  mobileOk(await loadMe(auth.userId, baseUrl)));

const patchSchema = z.object({ name: z.string().max(200) }).strict();

export const PATCH = authedMobileRoute("PATCH /api/mobile/v1/me", async (request, _params, { auth, baseUrl }) => {
  const body = await parseJsonBody(request, patchSchema);
  if ("response" in body) return body.response;
  // The web form always sends the profile image too; keep the current one.
  const current = await prisma.user.findUniqueOrThrow({ where: { id: auth.userId }, select: { profileImageUrl: true } });
  const result = await updateAccountProfileForUser(auth.userId, { name: body.data.name, profileImageUrl: current.profileImageUrl ?? "" });
  if (!result.ok) return mobileActionError(result);
  const user = await prisma.user.findUniqueOrThrow({ where: { id: auth.userId }, select: mobileUserSelect });
  return mobileOk(userDtoSchema.parse(toUserDto(user, baseUrl)));
});
