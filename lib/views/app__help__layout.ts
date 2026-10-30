import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { superAdminEmailFor } from "@/lib/permissions";
import type { HelpAccess } from "@/content/help/manifest";

/**
 * Which guide sections the current visitor may read (content/help/manifest.ts).
 * Public sections are for everyone; "org-admin" needs an owner or admin role
 * in any organisation; the super admin reads everything. This only decides
 * what the guide shows: it is never an authorization check for a feature.
 */
export async function loadHelpAccess(): Promise<HelpAccess[]> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!session || !userId) return ["public"];
  if (await superAdminEmailFor(session)) return ["public", "org-admin", "super-admin"];
  const adminMembership = await prisma.membership.findFirst({
    where: { userId, role: { in: ["OWNER", "ADMIN"] } },
    select: { id: true },
  });
  return adminMembership ? ["public", "org-admin"] : ["public"];
}
