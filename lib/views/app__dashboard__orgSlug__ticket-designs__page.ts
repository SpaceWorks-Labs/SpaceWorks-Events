import { prisma } from "@/lib/db";
import { requireOrgRole } from "@/lib/permissions";
import { STARTER_DESIGNS } from "@/lib/ticketDesign/presets";

type Props = { params: Promise<{ orgSlug: string; }>; };

/** The organisation's ticket design library (docs/TICKET_DESIGNER.md): owners and admins. */
export async function loadTicketDesignLibraryView({ params }: Props) {
  const { orgSlug } = await params;
  const { organisation } = await requireOrgRole(orgSlug, "ADMIN");
  const [designs, org] = await Promise.all([
    prisma.ticketDesign.findMany({ where: { organisationId: organisation.id, eventId: null }, orderBy: [{ updatedAt: "desc" }, { id: "desc" }], select: { id: true, name: true, updatedAt: true } }),
    prisma.organisation.findUnique({ where: { id: organisation.id }, select: { name: true, slug: true, defaultTicketDesignId: true } }),
  ]);
  return {
    organisation: { name: org?.name ?? organisation.name, slug: orgSlug },
    defaultId: org?.defaultTicketDesignId ?? null,
    designs: designs.map((design) => ({ id: design.id, name: design.name, updatedAt: design.updatedAt.toISOString() })),
    starters: STARTER_DESIGNS.map((starter) => ({ key: starter.key, label: starter.label })),
  };
}
