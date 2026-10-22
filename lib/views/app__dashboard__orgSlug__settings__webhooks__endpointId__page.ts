import { notFound } from "next/navigation";
import { requireOrgRole } from "@/lib/permissions";
import { getWebhookEndpointDetail } from "@/lib/webhooks/management";
import { WEBHOOK_AUTO_DISABLE_AFTER } from "@/lib/webhooks/delivery";

/** Owners and admins only. Scoped to this organisation: another tenant's endpoint id is a plain 404. */
export async function loadWebhookEndpointView({ params }: { params: Promise<{ orgSlug: string; endpointId: string; }>; }) {
  const { orgSlug, endpointId } = await params;
  const { organisation } = await requireOrgRole(orgSlug, "ADMIN");
  const detail = await getWebhookEndpointDetail(organisation.id, endpointId);
  if (!detail) notFound();
  return { organisation: { slug: organisation.slug }, autoDisableAfter: WEBHOOK_AUTO_DISABLE_AFTER, ...detail };
}
