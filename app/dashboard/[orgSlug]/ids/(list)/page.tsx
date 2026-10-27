import { loadMemberIdsView } from "@/lib/views/app__dashboard__orgSlug__ids__page";
import type { Metadata } from "next";
import Link from "next/link";
import { OrgPageHeader } from "@/components/dashboard/org/OrgPageHeader";
import { CreateIdProgrammeForm } from "@/components/member-ids/CreateIdProgrammeForm";
import { ProgrammeStatusPill } from "@/components/member-ids/ProgrammeStatusPill";
import { Card, EmptyState } from "@/components/ui/display";

export const metadata: Metadata = { title: "Member IDs", description: "ID card programmes for your organisation." };

type Props = { params: Promise<{ orgSlug: string; }>; };

export default async function MemberIdsPage({ params }: Props) {
  const { organisation, profile, programmes, canManage, pending } = await loadMemberIdsView({ params });
  return (
    <div className="flex flex-col gap-7 pb-4">
      <OrgPageHeader
        organisation={{ name: organisation.name, slug: organisation.slug, logoUrl: profile.logoUrl }}
        title="Member IDs"
        description="Digital ID cards for your members: a join form, approvals, printable cards and a public check page."
      />

      <div className="grid gap-7 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start">
        <section aria-labelledby="programmes-heading" className="flex min-w-0 flex-col gap-3">
          <h2 id="programmes-heading" className="text-h3 text-ink">Programmes</h2>
          {programmes.length === 0 ? (
            <EmptyState title="No ID programmes yet" mood="sleepy">
              {canManage
                ? "Create your first programme on the right. You'll design the card, then share the join link or import your members."
                : "When an owner or admin creates an ID programme, it shows up here."}
            </EmptyState>
          ) : (
            <ul className="flex flex-col gap-3">
              {programmes.map((programme) => {
                const waiting = pending.get(programme.id) ?? 0;
                return (
                  <li key={programme.id}>
                    <Link
                      href={`/dashboard/${organisation.slug}/ids/${programme.id}`}
                      className="flex flex-col gap-2 rounded-2xl border border-line bg-panel p-4 transition-colors hover:bg-subtle focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary sm:flex-row sm:items-center sm:justify-between"
                    >
                      <span className="min-w-0">
                        <span className="block break-words text-h4 text-ink">{programme.name}</span>
                        <span className="block text-caption text-ink-muted">
                          {programme._count.members} {programme._count.members === 1 ? "member" : "members"}
                          {waiting ? ` · ${waiting} waiting for approval` : ""}
                          {programme.status === "ACTIVE" ? (programme.registrationOpen ? " · Join form open" : " · Join form closed") : ""}
                        </span>
                      </span>
                      <ProgrammeStatusPill status={programme.status} />
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <aside className="flex min-w-0 flex-col gap-5">
          {canManage ? (
            <Card as="section" aria-labelledby="new-programme-heading">
              <h2 id="new-programme-heading" className="text-h4 text-ink">New programme</h2>
              <p className="mb-4 text-caption text-ink-muted">One programme per kind of card, like members, staff or volunteers.</p>
              <CreateIdProgrammeForm organisationSlug={organisation.slug} />
            </Card>
          ) : (
            <Card as="section">
              <p className="text-body-ui text-ink-secondary">You can view programmes and their members. Owners and admins approve members and issue cards.</p>
            </Card>
          )}
        </aside>
      </div>
    </div>
  );
}
