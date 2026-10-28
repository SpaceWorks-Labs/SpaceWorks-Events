import "server-only";

import { z } from "zod";
import { prisma } from "@/lib/db";
import { DEVICE_ID } from "@/lib/loginSecurity";
import type { IssuedMobileSession } from "@/lib/mobileAuth";
import { mobileUserSelect, toUserDto } from "@/lib/mobile/dto";
import { sessionDtoSchema } from "@/lib/mobile/schemas";

/**
 * `deviceId` is the app install's own random id (32 to 64 lowercase hex),
 * kept for the life of the install. Only its SHA-256 is stored: it marks a
 * known device for the sign-in protections and binds the session's refresh
 * token to the install.
 */
export const deviceFieldsSchema = {
  deviceId: z.string().trim().regex(DEVICE_ID, "Send the app install's id (32 to 64 lowercase hex characters)."),
  deviceName: z.string().trim().max(120).optional(),
  platform: z.enum(["android", "ios"]).optional(),
};

export async function sessionDto(issued: IssuedMobileSession, userId: string, baseUrl: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: mobileUserSelect });
  return sessionDtoSchema.parse({
    accessToken: issued.accessToken,
    accessTokenExpiresAt: issued.accessTokenExpiresAt.toISOString(),
    refreshToken: issued.refreshToken,
    refreshTokenExpiresAt: issued.refreshTokenExpiresAt.toISOString(),
    user: toUserDto(user, baseUrl),
  });
}
