import "server-only";

import { updateAccountProfile } from "@/app/actions/account";
import { forUser } from "./actor";

/* The signed-in person's own profile, by the account page's action body. */
export const updateAccountProfileForUser = (actorUserId: string | null, input: Parameters<typeof updateAccountProfile>[0]) => forUser(actorUserId, () => updateAccountProfile(input));
