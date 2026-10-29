import "server-only";

import { OrderStatus, type Prisma } from "@prisma/client";

/**
 * Add-on stock (docs/PAYMENTS.md). Extras with a limit count toward it in
 * confirmed orders and in orders whose hold is live; requests and ended
 * holds don't. Callers hold the event or series lock, which every order
 * selling these extras takes first, so the count can't change under them.
 */

/** How many of an add-on are taken, optionally leaving one order out. */
export async function addOnsTaken(tx: Prisma.TransactionClient, addOnId: string, now: Date, exceptOrderId?: string) {
  const sold = await tx.orderLine.aggregate({
    _sum: { quantity: true },
    where: {
      addOnId,
      order: {
        ...(exceptOrderId ? { id: { not: exceptOrderId } } : {}),
        OR: [{ status: OrderStatus.CONFIRMED }, { status: OrderStatus.PENDING, holdExpiresAt: { gt: now } }],
      },
    },
  });
  return sold._sum.quantity ?? 0;
}

/**
 * Whether an order's add-ons still fit their stock, counting everyone else:
 * before a request is held, an ended hold reopens, or a late payment takes
 * back what its hold had released. The order's priced lines never change.
 */
export async function addOnsFit(tx: Prisma.TransactionClient, orderId: string, now: Date) {
  const lines = await tx.orderLine.findMany({ where: { orderId, addOnId: { not: null } }, select: { quantity: true, addOn: { select: { id: true, capacity: true } } } });
  for (const line of lines) {
    if (!line.addOn || line.addOn.capacity == null) continue;
    if ((await addOnsTaken(tx, line.addOn.id, now, orderId)) + line.quantity > line.addOn.capacity) return false;
  }
  return true;
}
