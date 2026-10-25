import { notFound } from "next/navigation";
import { isProjectGalleryVisible, loadPublicResults } from "@/lib/core/judging";
import { parseSearchParam } from "@/lib/judgingPaging";
import { publicJudgingMetadata, resolvePublicJudgingEvent } from "@/lib/publicJudgingPage";

type Props = {
  params: Promise<{ orgSlug: string; eventSlug: string; }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined; }>;
};

export async function loadResultsMetadata({ params, searchParams }: Props) {
  const [{ orgSlug, eventSlug }, sp] = await Promise.all([params, searchParams]);
  return publicJudgingMetadata(orgSlug, eventSlug, "results", { filtered: parseSearchParam(sp.q) !== "" });
}

/**
 * Public results (docs/HACKATHON.md): awards and winning projects, only once
 * the organiser has published results. Never scores or judge comments. The
 * event page's visibility rules apply first; anything else is a 404.
 * `q` searches the winners.
 */
export async function loadResultsView({ params, searchParams }: Props) {
  const [{ orgSlug, eventSlug }, sp] = await Promise.all([params, searchParams]);
  const resolved = await resolvePublicJudgingEvent(orgSlug, eventSlug);
  if (!resolved) notFound();
  const { org, event, preview } = resolved;
  const results = await loadPublicResults(event.id, { query: parseSearchParam(sp.q) });
  if (!results) notFound();
  return { org, event, preview, results, galleryOpen: isProjectGalleryVisible(event) };
}
