import type { Metadata } from "next";
import { OrganisationEmailForm } from "@/components/settings/OrganisationEmailForm";
import { PageHeader } from "@/components/ui/display";
import { loadOrganisationEmailView } from "@/lib/views/app__dashboard__orgSlug__settings__email__page";
import { HelpLink } from "@/components/help/HelpLink";

export const metadata: Metadata = { title: "Email", description: "How your organisation's email reaches guests." };

export default async function OrganisationEmailPage({ params }: { params: Promise<{ orgSlug: string; }>; }) {
  const { organisation, status, platformAddress } = await loadOrganisationEmailView({ params });
  return (
    <div className="flex flex-col gap-6 pb-6">
      <PageHeader
        title="Email"
        description="Tickets, reminders, updates and receipts go out under your name, through the platform or your own mail server."
        actions={<HelpLink article="organisations/email-sending" />}
      />
      <OrganisationEmailForm organisationSlug={organisation.slug} organisationName={organisation.name} platformAddress={platformAddress} initial={status} />
    </div>
  );
}
