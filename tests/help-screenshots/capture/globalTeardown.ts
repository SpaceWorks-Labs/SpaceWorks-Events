import { PrismaClient } from "@prisma/client";

/** Drops anything queued during the run, so a capture never delivers email, webhooks or chat messages. */
export default async function globalTeardown() {
  const prisma = new PrismaClient();
  try {
    await prisma.outboxMessage.deleteMany({});
    await prisma.webhookDelivery.deleteMany({ where: { status: { in: ["PENDING", "PROCESSING", "FAILED"] } } });
  } finally {
    await prisma.$disconnect();
  }
}
