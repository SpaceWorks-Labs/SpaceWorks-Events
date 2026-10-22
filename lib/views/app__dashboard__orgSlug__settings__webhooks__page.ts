import { requireOrgRole } from "@/lib/permissions";
import { listWebhookEndpoints } from "@/lib/webhooks/management";
import { MAX_WEBHOOK_ENDPOINTS_PER_ORGANISATION } from "@/lib/webhooks/eventTypes";

/** Owners and admins only; members and co-organisers are redirected away. */
export async function loadWebhooksSettingsView({ params }: { params: Promise<{ orgSlug: string; }>; }) {
  const { orgSlug } = await params;
  const { organisation } = await requireOrgRole(orgSlug, "ADMIN");
  const endpoints = await listWebhookEndpoints(organisation.id);
  return { organisation: { slug: organisation.slug, name: organisation.name }, endpoints, maxEndpoints: MAX_WEBHOOK_ENDPOINTS_PER_ORGANISATION };
}
