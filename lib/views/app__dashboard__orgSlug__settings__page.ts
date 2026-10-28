import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { canDeleteOrg, requireOrgRole } from "@/lib/permissions";
import { configuredProvider, isProviderTestMode } from "@/lib/payments/settings";
import { countWebhookEndpoints } from "@/lib/webhooks/management";
type Props = { params: Promise<{ orgSlug: string; }>; };

export async function loadOrgSettingsView({ params }: Props) {

  const { orgSlug } = await params;
  const { organisation, membership } = await requireOrgRole(orgSlug, "ADMIN");

  const org = await prisma.organisation.findUnique({
    where: { id: organisation.id },
    select: { name: true, description: true, logoUrl: true, slug: true },
  });

  if (!org) notFound();

  const isOwner = membership.role === "OWNER";
  const canDelete = canDeleteOrg(membership);
  // Owner-only, tenant-scoped counts. "Active" means the client is enabled and
  // holds at least one credential that is neither revoked nor expired.
  const now = new Date();
  const [totalApiClients, activeApiClients] = isOwner
    ? await Promise.all([
      prisma.apiClient.count({ where: { organisationId: organisation.id } }),
      prisma.apiClient.count({
        where: {
          organisationId: organisation.id,
          status: "ACTIVE",
          credentials: { some: { revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] } },
        },
      }),
    ])
    : [0, 0];

  // Owner-only summary: which provider is ready, never key material.
  const paymentRow = isOwner
    ? await prisma.organisationPaymentSettings.findUnique({ where: { organisationId: organisation.id } })
    : null;
  const paymentProvider = configuredProvider(paymentRow);
  const payments = { provider: paymentProvider, testMode: paymentRow && paymentProvider ? isProviderTestMode(paymentRow, paymentProvider) : false };

  const emailRow = isOwner
    ? await prisma.organisationEmailSettings.findUnique({ where: { organisationId: organisation.id }, select: { useOwnServer: true } })
    : null;
  const email = { useOwnServer: emailRow?.useOwnServer ?? false };

  const chatChannels = await prisma.chatChannel.count({ where: { organisationId: organisation.id } });
  // The page itself is OWNER/ADMIN only, and so are webhooks (canManageWebhooks).
  const webhooks = await countWebhookEndpoints(organisation.id);

  return { org, organisation, membership, isOwner, canDelete, totalApiClients, activeApiClients, payments, email, chatChannels, webhooks };
}
