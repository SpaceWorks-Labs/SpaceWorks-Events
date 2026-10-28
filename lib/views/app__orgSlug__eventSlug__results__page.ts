import { notFound } from "next/navigation";
import { isProjectGalleryVisible, loadPublicResults } from "@/lib/core/judging";
import { parseSearchParam } from "@/lib/judgingPaging";
import { publicJudgingMetadata, resolvePublicJudgingEvent } from "@/lib/publicJudgingPage";
import { loadPublicFinalists } from "@/lib/core/judgingRounds";

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
 * the organiser has published results, and a Finalists block per round whose
 * finalists are published (docs/HACKATHON.md "Rounds"), which can come
 * before the results. Never scores, ranks or judge comments. The event
 * page's visibility rules apply first; with neither published it is a 404.
 * `q` searches the winners.
 */
export async function loadResultsView({ params, searchParams }: Props) {
  const [{ orgSlug, eventSlug }, sp] = await Promise.all([params, searchParams]);
  const resolved = await resolvePublicJudgingEvent(orgSlug, eventSlug);
  if (!resolved) notFound();
  const { org, event, preview } = resolved;
  const [results, finalists] = await Promise.all([loadPublicResults(event.id, { query: parseSearchParam(sp.q) }), loadPublicFinalists(event.id)]);
  if (!results && finalists.length === 0) notFound();
  return { org, event, preview, results, finalists, galleryOpen: isProjectGalleryVisible(event) };
}
