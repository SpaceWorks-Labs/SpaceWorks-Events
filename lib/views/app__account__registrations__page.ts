import { requireAuth } from "@/lib/permissions";
import { accountPageParam, loadAccountRegistrations, type AccountPages } from "@/lib/accountRegistrations";

type Props = {
  searchParams: Promise<{ upcoming?: string | string[]; past?: string | string[]; certificates?: string | string[] }>;
};

export async function loadAccountRegistrationsView({ searchParams }: Props) {
  // The page authenticates itself; the account layout is not an authorization boundary.
  const session = await requireAuth();
  const sp = await searchParams;
  const requested: AccountPages = {
    upcoming: accountPageParam(sp.upcoming),
    past: accountPageParam(sp.past),
    certificates: accountPageParam(sp.certificates),
  };
  const { upcoming, past, certificates, pagination } = await loadAccountRegistrations(session.user.id, new Date(), requested);
  // Links use the pages actually shown (a page past the end is clamped).
  const pages: AccountPages = {
    upcoming: pagination.upcoming.page,
    past: pagination.past.page,
    certificates: pagination.certificates.page,
  };
  return { upcoming, past, certificates, pagination, pages };
}
