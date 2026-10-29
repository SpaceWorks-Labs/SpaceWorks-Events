import "server-only";

import type { Prisma } from "@prisma/client";

/** Caller holds the organisation fence and series lock and has checked obligations. */
export async function removeSeriesTx(tx: Prisma.TransactionClient, seriesId: string) {
  await tx.$queryRaw`SELECT "id" FROM "EventInstance" WHERE "eventSeriesId" = ${seriesId} ORDER BY "id" FOR UPDATE`;
  await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "eventSeriesId" = ${seriesId} ORDER BY "id" FOR UPDATE`;
  // The two SET NULL foreign keys can otherwise leave a date without its series
  // between cascade statements, violating Order_one_target. Preserve the ledger.
  await tx.order.updateMany({ where: { eventSeriesId: seriesId }, data: { eventSeriesId: null, eventInstanceId: null } });
  await tx.eventSeries.delete({ where: { id: seriesId } });
}
