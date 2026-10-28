import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { seedHelpScreens } from "../seed";
import { SEED_FILE } from "./state";

/** Seeds the disposable database once and records the ids and links the capture steps need. */
export default async function globalSetup() {
  const prisma = new PrismaClient();
  try {
    const seed = await seedHelpScreens(prisma);
    fs.mkdirSync(path.dirname(SEED_FILE), { recursive: true });
    fs.writeFileSync(SEED_FILE, JSON.stringify(seed, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}
