import type { Metadata } from "next";
import { PaymentSettingsForm } from "@/components/payments/PaymentSettingsForm";
import { ReceiptDetailsForm } from "@/components/payments/ReceiptDetailsForm";
import { Callout, PageHeader } from "@/components/ui/display";
import { loadPaymentSettingsView } from "@/lib/views/app__dashboard__orgSlug__settings__payments__page";
import { HelpLink } from "@/components/help/HelpLink";

export const metadata: Metadata = { title: "Payments", description: "Connect your organisation's own payment account." };

export default async function PaymentSettingsPage({ params }: { params: Promise<{ orgSlug: string; }>; }) {
  const { organisation, status, webhookUrls, paidEventsEnabled, receipt } = await loadPaymentSettingsView({ params });
  return (
    <div className="flex flex-col gap-6 pb-6">
      <PageHeader
        title="Payments"
        description="Connect your own Razorpay or Stripe account to sell tickets. Attendees pay on the provider's page and the money goes straight to you."
        actions={<HelpLink article="payments/connect-a-provider" />}
      />
      {paidEventsEnabled ? null : (
        <Callout tone="info" title="Paid events are off on this installation">
          You can connect an account now. Tickets can be sold once the installation&apos;s administrator turns paid events on.
        </Callout>
      )}
      <PaymentSettingsForm organisationSlug={organisation.slug} initial={status} webhookUrls={webhookUrls} />
      <ReceiptDetailsForm organisationSlug={organisation.slug} organisationName={organisation.name} initial={receipt} />
    </div>
  );
}
