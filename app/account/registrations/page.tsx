import { loadAccountRegistrationsView } from "@/lib/views/app__account__registrations__page";
import type { Metadata } from "next";
import { accountSectionHref } from "@/lib/accountLimits";
import { AccountSection, CertificateList, RegistrationList, SectionPager } from "@/components/account/registrations/RegistrationSections";
import { DataExportCard } from "@/components/account/DataExportCard";

export const metadata: Metadata = {
  title: "Your registrations",
  robots: { index: false, follow: false },
  // Rows link to opaque ticket URLs; never leak them through Referer.
  referrer: "no-referrer",
};

export const dynamic = "force-dynamic";

type Props = {
  searchParams: Promise<{ upcoming?: string | string[]; past?: string | string[]; certificates?: string | string[] }>;
};

export default async function AccountRegistrationsPage({ searchParams }: Props) {
  const { upcoming, past, certificates, pagination, pages } = await loadAccountRegistrationsView({ searchParams });
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <AccountSection id="upcoming" title="Upcoming" description="Events you've registered for that haven't ended yet, soonest first.">
        <RegistrationList
          rows={upcoming}
          past={false}
          emptyTitle="Nothing coming up"
          emptyBody="When you register for an event, your ticket and the details will be here."
          footer={<SectionPager label="Upcoming pages" pagination={pagination.upcoming} hrefFor={(page) => accountSectionHref(pages, "upcoming", page)} />}
        />
      </AccountSection>

      <AccountSection id="past" title="Past" description="Events you registered for that have already ended, most recent first.">
        <RegistrationList
          rows={past}
          past
          emptyTitle="No past events yet"
          emptyBody="Events you've attended or registered for will be kept here after they end."
          footer={<SectionPager label="Past pages" pagination={pagination.past} hrefFor={(page) => accountSectionHref(pages, "past", page)} />}
        />
      </AccountSection>

      <AccountSection id="certificates" title="Certificates" description="Certificates of participation from events you gave feedback on.">
        <CertificateList
          rows={certificates}
          footer={
            <SectionPager label="Certificate pages" pagination={pagination.certificates} hrefFor={(page) => accountSectionHref(pages, "certificates", page)} />
          }
        />
      </AccountSection>

      <DataExportCard />
    </div>
  );
}
