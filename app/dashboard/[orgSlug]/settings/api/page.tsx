import { loadApiAccessView } from "@/lib/views/app__dashboard__orgSlug__settings__api__page";
import type { Metadata } from "next";
import { ApiClientManagement } from "@/components/api-clients/ApiClientManagement";
import { ApiDeveloperReference } from "@/components/api-clients/ApiDeveloperReference";
import { isApiScope } from "@/lib/api/v1/scopes";
import { PageHeader } from "@/components/ui/display";
import { HelpLink } from "@/components/help/HelpLink";

export const metadata: Metadata = { title: "API access", description: "Manage machine-to-machine access." };

export default async function ApiAccessPage({ params }: { params: Promise<{ orgSlug: string; }>; }) {
  const { organisation, clients, apiBaseUrl } = await loadApiAccessView({ params });
  return (
    <div className="flex flex-col gap-8 pb-6">
      <PageHeader title="API access" description="Create tenant-bound machine identities and rotate their credentials." actions={<HelpLink article="developers/api" />} />
      <ApiClientManagement
        organisationSlug={organisation.slug}
        referenceTime={new Date().toISOString()}
        clients={clients.map((client) => ({
          ...client,
          scopes: client.scopes.map(({ scope }) => scope).filter(isApiScope),
          credentials: client.credentials.map((credential) => ({
            ...credential,
            createdAt: credential.createdAt.toISOString(),
            expiresAt: credential.expiresAt?.toISOString() ?? null,
            revokedAt: credential.revokedAt?.toISOString() ?? null,
            lastUsedAt: credential.lastUsedAt?.toISOString() ?? null,
          })),
        }))}
      />
      <ApiDeveloperReference apiBaseUrl={apiBaseUrl} />
    </div>
  );
}
