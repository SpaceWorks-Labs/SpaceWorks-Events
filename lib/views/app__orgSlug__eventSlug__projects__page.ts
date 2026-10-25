import { notFound } from "next/navigation";
import { loadProjectGallery } from "@/lib/core/judging";
import { isFilteredGalleryView, parseGalleryParams } from "@/lib/judgingPaging";
import { publicJudgingMetadata, resolvePublicJudgingEvent } from "@/lib/publicJudgingPage";

type Props = {
  params: Promise<{ orgSlug: string; eventSlug: string; }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined; }>;
};

export async function loadProjectsMetadata({ params, searchParams }: Props) {
  const [{ orgSlug, eventSlug }, sp] = await Promise.all([params, searchParams]);
  // Lenient on purpose: any valid filter or order counts, so a filtered view
  // never claims its own canonical URL.
  const view = parseGalleryParams(sp, true);
  return publicJudgingMetadata(orgSlug, eventSlug, "projects", { page: view.page, filtered: isFilteredGalleryView(view) });
}

/**
 * Public project gallery (docs/HACKATHON.md): submitted projects only, once
 * the submission window has closed and the organiser made the gallery public.
 * The event page's visibility rules apply first; anything else is a 404.
 * One page of projects for the URL's `page`, `q`, `filter` and `sort`.
 */
export async function loadProjectsView({ params, searchParams }: Props) {
  const [{ orgSlug, eventSlug }, sp] = await Promise.all([params, searchParams]);
  const resolved = await resolvePublicJudgingEvent(orgSlug, eventSlug);
  if (!resolved) notFound();
  const { org, event, preview } = resolved;
  const requested = parseGalleryParams(sp, event.resultsPublishedAt != null);
  const gallery = await loadProjectGallery(event.id, undefined, requested);
  if (!gallery) notFound();
  return { org, event, preview, gallery, requested };
}
