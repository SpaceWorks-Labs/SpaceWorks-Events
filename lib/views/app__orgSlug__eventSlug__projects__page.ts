import { notFound } from "next/navigation";
import { loadProjectGallery } from "@/lib/core/judging";
import { parsePageParam, parseSearchParam } from "@/lib/judgingPaging";
import { publicJudgingMetadata, resolvePublicJudgingEvent } from "@/lib/publicJudgingPage";

type Props = {
  params: Promise<{ orgSlug: string; eventSlug: string; }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined; }>;
};

export async function loadProjectsMetadata({ params, searchParams }: Props) {
  const [{ orgSlug, eventSlug }, sp] = await Promise.all([params, searchParams]);
  return publicJudgingMetadata(orgSlug, eventSlug, "projects", { page: parsePageParam(sp.page), searched: parseSearchParam(sp.q) !== "" });
}

/**
 * Public project gallery (docs/HACKATHON.md): submitted projects only, once
 * the submission window has closed and the organiser made the gallery public.
 * The event page's visibility rules apply first; anything else is a 404.
 * One page of projects (`?page=N`, optional `?q=` search).
 */
export async function loadProjectsView({ params, searchParams }: Props) {
  const [{ orgSlug, eventSlug }, sp] = await Promise.all([params, searchParams]);
  const resolved = await resolvePublicJudgingEvent(orgSlug, eventSlug);
  if (!resolved) notFound();
  const { org, event, preview } = resolved;
  const requestedPage = parsePageParam(sp.page);
  const gallery = await loadProjectGallery(event.id, undefined, { page: requestedPage, query: parseSearchParam(sp.q) });
  if (!gallery) notFound();
  return { org, event, preview, gallery, requestedPage };
}
