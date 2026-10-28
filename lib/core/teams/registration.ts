import "server-only";

import { submitRsvpCore } from "@/lib/rsvpCore";
import { teamRegistrationIntentSchema } from "@/lib/validators";

// ---------------------------------------------------------------------------
// Registration (public form)
// ---------------------------------------------------------------------------

/** Register and create a team in one step; the registrant becomes its leader. */
export function createTeamRegistration(
  input: unknown,
  opts: { userId: string | null; teamName: unknown },
): ReturnType<typeof submitRsvpCore> {
  const intent = teamRegistrationIntentSchema.safeParse({ mode: "create", name: opts.teamName });
  if (!intent.success) return Promise.resolve({ ok: false, error: "Enter a valid team name.", fieldErrors: { teamName: intent.error.issues.map((i) => i.message) } });
  return submitRsvpCore(input, { userId: opts.userId, team: intent.data });
}

/** Register into an existing team from its join link. Takes the team's status. */
export function joinTeamByToken(
  input: unknown,
  opts: { userId: string | null; joinToken: unknown },
): ReturnType<typeof submitRsvpCore> {
  const intent = teamRegistrationIntentSchema.safeParse({ mode: "join", joinToken: opts.joinToken });
  if (!intent.success) return Promise.resolve({ ok: false, error: "This team link is no longer valid. Ask your team leader for a new one." });
  return submitRsvpCore(input, { userId: opts.userId, team: intent.data });
}
