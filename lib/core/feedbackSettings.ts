import "server-only";

import { saveFeedbackSettings } from "@/app/actions/feedback-form";
import { forUser } from "./actor";

/* Feedback form settings for API callers (organisation OWNER/ADMIN), by the dashboard's action body. */
export const saveFeedbackSettingsForUser = (actorUserId: string | null, input: unknown) => forUser(actorUserId, () => saveFeedbackSettings(input));
