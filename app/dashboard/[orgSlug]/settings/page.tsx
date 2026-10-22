import { loadOrgSettingsView } from "@/lib/views/app__dashboard__orgSlug__settings__page";
import Link from "next/link";
import { CreditCard, ExternalLink, KeyRound, Mail, MessageSquare, Webhook } from "lucide-react";
import { EditOrgForm } from "@/components/org/EditOrgForm";
import { CopyOrganisationUrl } from "@/components/org/CopyOrganisationUrl";
import { DeleteOrganisationButton } from "@/components/dashboard/DeleteOrganisationButton";
import { OrgPageHeader } from "@/components/dashboard/org/OrgPageHeader";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/display";
import { cn } from "@/lib/cn";

import type { Metadata } from "next";

type Props = { params: Promise<{ orgSlug: string; }>; };

export const metadata: Metadata = {
  title: "Settings",
  description: "Edit organisation details.",
};

const sectionCard = "rounded-xl border border-line bg-panel p-5 sm:p-6";

export default async function OrgSettingsPage({ params }: Props) {
  const { org, isOwner, canDelete, totalApiClients, activeApiClients, payments, email, chatChannels, webhooks } = await loadOrgSettingsView({ params });
  return (
    <div className="flex flex-col gap-7">
      <OrgPageHeader
        organisation={{ name: org.name, slug: org.slug, logoUrl: org.logoUrl }}
        title="Settings"
        description={`What people see on your public page, and how ${org.name} connects to other tools.`}
      />

      <div className="flex min-w-0 flex-col gap-6">
        <EditOrgForm
          id="profile"
          organisationSlug={org.slug}
          initial={{
            name: org.name,
            description: org.description ?? "",
            logoUrl: org.logoUrl,
          }}
        />

        <section id="public-page" aria-labelledby="public-page-title" className={cn(sectionCard, "flex flex-col gap-4 md:flex-row md:items-center")}>
          <div className="min-w-0 flex-1">
            <h2 id="public-page-title" className="text-h4 text-ink">Public page</h2>
            <p className="mt-0.5 text-body-ui text-ink-muted">One link that always lists what is coming up. The address can&apos;t be changed.</p>
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="max-w-full truncate rounded-full bg-muted px-3.5 py-2 tabular-nums text-sm text-ink-secondary">/{org.slug}</span>
            <CopyOrganisationUrl slug={org.slug} />
            <Link
              href={`/${org.slug}`}
              className="inline-flex min-h-9 items-center gap-1 px-2 text-sm font-semibold text-ink-secondary underline-offset-4 hover:text-ink hover:underline"
            >
              Open
              <ExternalLink aria-hidden className="size-3.5" />
            </Link>
          </div>
        </section>

        {isOwner ? (
          <section id="api-access" aria-labelledby="api-access-title" className={cn(sectionCard, "flex flex-col gap-4 md:flex-row md:items-center")}>
            <div className="min-w-0 flex-1">
              <h2 id="api-access-title" className="text-h4 text-ink">API access</h2>
              <p className="mt-0.5 text-body-ui text-ink-muted">Let another system read your events with a scoped, rotatable key.</p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Chip tone={activeApiClients > 0 ? "success" : "neutral"}>
                {totalApiClients === 0
                  ? "No clients yet"
                  : activeApiClients === 0
                    ? "No active clients"
                    : `${activeApiClients} active ${activeApiClients === 1 ? "client" : "clients"}`}
              </Chip>
              <Button asChild variant="secondary">
                <Link href={`/dashboard/${org.slug}/settings/api`}>
                  <KeyRound aria-hidden className="size-4" />
                  Manage API access
                </Link>
              </Button>
            </div>
          </section>
        ) : null}

        {isOwner ? (
          <section id="payments" aria-labelledby="payments-title" className={cn(sectionCard, "flex flex-col gap-4 md:flex-row md:items-center")}>
            <div className="min-w-0 flex-1">
              <h2 id="payments-title" className="text-h4 text-ink">Payments</h2>
              <p className="mt-0.5 text-body-ui text-ink-muted">Connect your own Razorpay or Stripe account to sell tickets. Money goes straight to you.</p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Chip tone={payments.provider ? "success" : "neutral"}>
                {payments.provider ? `${payments.provider === "RAZORPAY" ? "Razorpay" : "Stripe"} connected` : "Not connected"}
              </Chip>
              {payments.testMode ? <Chip tone="warning">Test mode</Chip> : null}
              <Button asChild variant="secondary">
                <Link href={`/dashboard/${org.slug}/settings/payments`}>
                  <CreditCard aria-hidden className="size-4" />
                  Manage payments
                </Link>
              </Button>
            </div>
          </section>
        ) : null}

        {isOwner ? (
          <section id="email" aria-labelledby="email-title" className={cn(sectionCard, "flex flex-col gap-4 md:flex-row md:items-center")}>
            <div className="min-w-0 flex-1">
              <h2 id="email-title" className="text-h4 text-ink">Email</h2>
              <p className="mt-0.5 text-body-ui text-ink-muted">The sender name and reply-to on your guests&apos; email, or your own mail server.</p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Chip tone={email.useOwnServer ? "success" : "neutral"}>{email.useOwnServer ? "Your mail server" : "Platform mail"}</Chip>
              <Button asChild variant="secondary">
                <Link href={`/dashboard/${org.slug}/settings/email`}>
                  <Mail aria-hidden className="size-4" />
                  Manage email
                </Link>
              </Button>
            </div>
          </section>
        ) : null}

        <section id="chat" aria-labelledby="chat-title" className={cn(sectionCard, "flex flex-col gap-4 md:flex-row md:items-center")}>
          <div className="min-w-0 flex-1">
            <h2 id="chat-title" className="text-h4 text-ink">Chat notifications</h2>
            <p className="mt-0.5 text-body-ui text-ink-muted">Tell your team&apos;s Slack, Discord, Mattermost, Telegram or WhatsApp about registrations, requests, payments and refunds.</p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Chip tone={chatChannels > 0 ? "success" : "neutral"}>{chatChannels > 0 ? `${chatChannels} connected` : "None connected"}</Chip>
            <Button asChild variant="secondary">
              <Link href={`/dashboard/${org.slug}/settings/chat`}>
                <MessageSquare aria-hidden className="size-4" />
                Manage chats
              </Link>
            </Button>
          </div>
        </section>

        <section id="webhooks" aria-labelledby="webhooks-title" className={cn(sectionCard, "flex flex-col gap-4 md:flex-row md:items-center")}>
          <div className="min-w-0 flex-1">
            <h2 id="webhooks-title" className="text-h4 text-ink">Webhooks</h2>
            <p className="mt-0.5 text-body-ui text-ink-muted">Send registrations, check-ins and other events to your own systems as they happen.</p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Chip tone={webhooks.enabled > 0 ? "success" : "neutral"}>
              {webhooks.total === 0
                ? "No endpoints yet"
                : webhooks.enabled === 0
                  ? "No active endpoints"
                  : `${webhooks.enabled} active ${webhooks.enabled === 1 ? "endpoint" : "endpoints"}`}
            </Chip>
            <Button asChild variant="secondary">
              <Link href={`/dashboard/${org.slug}/settings/webhooks`}>
                <Webhook aria-hidden className="size-4" />
                Manage webhooks
              </Link>
            </Button>
          </div>
        </section>

        {canDelete ? (
          <section
            id="danger-zone"
            aria-labelledby="danger-zone-title"
            className={cn(sectionCard, "flex flex-col gap-4 border-[1.5px] border-danger-border md:flex-row md:items-center")}
          >
            <div className="min-w-0 flex-1">
              <h2 id="danger-zone-title" className="text-h4 text-danger-fg">Delete organisation</h2>
              <p className="mt-0.5 text-body-ui text-ink-secondary">
                Permanently removes {org.name} with all of its events, registrations and memberships. You&apos;ll be asked to type the name to confirm.
              </p>
            </div>
            <div className="shrink-0">
              <DeleteOrganisationButton organisationSlug={org.slug} organisationName={org.name} />
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}
