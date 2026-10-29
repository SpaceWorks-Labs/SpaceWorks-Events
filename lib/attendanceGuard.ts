import "server-only";

import { AttendanceResponse, type Prisma } from "@prisma/client";

/**
 * The attendance "No" a release acts for (docs/ATTENDANCE.md): its check and
 * the time that answer was recorded. A cancellation, refund or refund
 * request started by a "No" goes ahead only while that exact answer is still
 * the current one, so an older "No" can never undo a newer "Yes".
 */
export type AttendanceNo = { checkId: string; respondedAt: Date; };

export const ANSWER_CHANGED = "Your answer changed meanwhile, so nothing was released.";

/**
 * Lock the attendance check row, the last lock of the release transaction
 * (after the event or dates, the order, its payments and the registrations),
 * and say whether the "No" is still the current answer. A "Yes" written
 * after this waits until the release commits; a release that deletes the
 * registration deletes the check with it, so that "Yes" then finds no link.
 */
export async function lockCurrentNo(tx: Prisma.TransactionClient, no: AttendanceNo) {
  await tx.$queryRaw`SELECT "id" FROM "AttendanceCheck" WHERE "id" = ${no.checkId} FOR UPDATE`;
  const check = await tx.attendanceCheck.findUnique({ where: { id: no.checkId }, select: { response: true, respondedAt: true } });
  return check?.response === AttendanceResponse.NOT_ATTENDING && check.respondedAt?.getTime() === no.respondedAt.getTime();
}
