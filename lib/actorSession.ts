import "server-only";

import type { Session } from "next-auth";
import { prisma } from "@/lib/db";
import type { MobileRequestActor as RequestActor } from "@/lib/requestActor";
import { mobileMfaFresh } from "@/lib/staffMfaFresh";

const loaded = new WeakMap<RequestActor, Promise<Session | null>>();

/**
 * The session shape `auth()` returns for a request actor, read once per
 * request. A deleted user has no session.
 */
export function actorSession(actor: RequestActor): Promise<Session | null> {
  let session = loaded.get(actor);
  if (!session) {
    session = prisma.user.findUnique({ where: { id: actor.userId }, select: { id: true, name: true, email: true, image: true } }).then((user) => user ? {
      user: { id: user.id, name: user.name, email: user.email, image: user.image },
      expires: new Date(Date.now() + 15 * 60_000).toISOString(),
      authenticatedAt: actor.authenticatedAt.getTime(),
      mfaVerified: mobileMfaFresh(actor.mfaVerifiedAt),
    } as Session : null);
    loaded.set(actor, session);
  }
  return session;
}
