import "server-only";

import crypto from "node:crypto";
import type { Prisma } from "@prisma/client";
import { assignTeamLeaderTx } from "@/lib/teamUnits";

/** A new ticket link: the old one stops working once a ticket changes hands. */
export function newTicketToken() {
  return crypto.randomBytes(18).toString("base64url");
}

/**
 * A registration changed hands: a ticket transfer (lib/payments/transfers.ts)
 * or an organiser changing the holder's email (app/actions/rsvp-admin.ts).
 * In the caller's transaction, after it has locked the registration (behind
 * its Event or series locks) and written the new holder, every bearer link the
 * previous holder was given for this registration stops working:
 *
 * - the attendance question is deleted, so the next send asks the new holder
 *   afresh (docs/ATTENDANCE.md). A "No" the old holder answered meanwhile
 *   finds no current answer under the release lock and releases nothing
 *   (lib/attendanceGuard.ts);
 * - the solo submission link is deleted. The project stays with the
 *   registration; the new holder requests a new link (docs/HACKATHON.md);
 * - a team leader's management link is rotated and the new link emailed to
 *   the new holder (`assignTeamLeaderTx`).
 *
 * Personal expense claims are detached from the transferable registration;
 * their payee snapshots, decisions, receipts and payouts stay for organisers.
 * The caller rotates the ticket token itself.
 */
export async function retireHolderCapabilities(tx: Prisma.TransactionClient, rsvpId: string) {
  // Claims belong to their original payee, never to the replacement holder.
  // Keep the financial records for organisers, without transferable ticket authority.
  await tx.expenseClaim.updateMany({ where: { rsvpId }, data: { rsvpId: null } });
  await tx.attendanceCheck.deleteMany({ where: { rsvpId } });
  await tx.submissionLink.deleteMany({ where: { rsvpId } });
  const led = await tx.team.findUnique({ where: { leaderRsvpId: rsvpId }, select: { id: true } });
  if (led) await assignTeamLeaderTx(tx, { teamId: led.id, leaderRsvpId: rsvpId, reason: "leader" });
}
