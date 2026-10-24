import { notFound } from "next/navigation";
import { loadProjectGallery } from "@/lib/core/judging";
import { publicJudgingMetadata, resolvePublicJudgingEvent } from "@/lib/publicJudgingPage";

type Props = { params: Promise<{ orgSlug: string; eventSlug: string; }>; };

export async function loadProjectsMetadata({ params }: Props) {
  const { orgSlug, eventSlug } = await params;
  return publicJudgingMetadata(orgSlug, eventSlug, "projects");
}

/**
 * Public project gallery (docs/HACKATHON.md): submitted projects only, once
 * the submission window has closed and the organiser made the gallery public.
 * The event page's visibility rules apply first; anything else is a 404.
 */
export async function loadProjectsView({ params }: Props) {
  const { orgSlug, eventSlug } = await params;
  const resolved = await resolvePublicJudgingEvent(orgSlug, eventSlug);
  if (!resolved) notFound();
  const { org, event, preview } = resolved;
  const gallery = await loadProjectGallery(event.id);
  if (!gallery) notFound();
  return { org, event, preview, gallery };
}
