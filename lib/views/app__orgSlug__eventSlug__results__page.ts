import { notFound } from "next/navigation";
import { isProjectGalleryVisible, loadPublicResults } from "@/lib/core/judging";
import { publicJudgingMetadata, resolvePublicJudgingEvent } from "@/lib/publicJudgingPage";

type Props = { params: Promise<{ orgSlug: string; eventSlug: string; }>; };

export async function loadResultsMetadata({ params }: Props) {
  const { orgSlug, eventSlug } = await params;
  return publicJudgingMetadata(orgSlug, eventSlug, "results");
}

/**
 * Public results (docs/HACKATHON.md): awards and winning projects, only once
 * the organiser has published results. Never scores or judge comments. The
 * event page's visibility rules apply first; anything else is a 404.
 */
export async function loadResultsView({ params }: Props) {
  const { orgSlug, eventSlug } = await params;
  const resolved = await resolvePublicJudgingEvent(orgSlug, eventSlug);
  if (!resolved) notFound();
  const { org, event, preview } = resolved;
  const results = await loadPublicResults(event.id);
  if (!results) notFound();
  return { org, event, preview, results, galleryOpen: isProjectGalleryVisible(event) };
}
