import type { z } from "zod";
import type { eventCountsSchema, eventPermissionsSchema, guestSchema } from "./schemas/organiser";
import type { eventSummarySchema, myTeamSchema, registrationFieldSchema } from "./schemas/events";
import type { judgeSubmissionSchema, organiserTeamSchema } from "./schemas/judging";
import type { userDtoSchema } from "./schemas/core";

/*
 * Response DTOs for /api/mobile/v1, split by area under lib/mobile/schemas/.
 * Every route parses its payload through one of these strict schemas.
 */
export * from "./schemas/core";
export * from "./schemas/events";
export * from "./schemas/organiser";
export * from "./schemas/judging";
export * from "./schemas/commerce";
export * from "./schemas/mentor";

export type UserDto = z.infer<typeof userDtoSchema>;
export type EventSummaryDto = z.infer<typeof eventSummarySchema>;
export type GuestDto = z.infer<typeof guestSchema>;
export type EventPermissionsDto = z.infer<typeof eventPermissionsSchema>;
export type EventCountsDto = z.infer<typeof eventCountsSchema>;
export type RegistrationFieldDto = z.infer<typeof registrationFieldSchema>;
export type MyTeamDto = z.infer<typeof myTeamSchema>;
export type OrganiserTeamMobileDto = z.infer<typeof organiserTeamSchema>;
export type JudgeSubmissionMobileDto = z.infer<typeof judgeSubmissionSchema>;
