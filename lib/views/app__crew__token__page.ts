import { notFound } from "next/navigation";
import { FOOD_PREFERENCE_SUGGESTIONS, isCrewJoinTokenShape, loadCrewJoinPage } from "@/lib/core/crew";

/**
 * The crew sign-up page by its link (docs/CREW.md). Unknown, rotated and
 * malformed tokens share the generic 404. Returns only the event title,
 * organisation name and date; never other crew, the venue or the event slug.
 */
export async function loadCrewJoinView({ params }: { params: Promise<{ token: string; }>; }) {
  const { token } = await params;
  const raw = token?.trim() ?? "";
  if (!isCrewJoinTokenShape(raw)) notFound();
  const page = await loadCrewJoinPage(raw);
  if (!page) notFound();
  return {
    token: raw,
    eventTitle: page.eventTitle,
    organisationName: page.organisationName,
    startDateTime: page.startDateTime,
    timezone: page.timezone,
    open: page.open,
    foodSuggestions: [...FOOD_PREFERENCE_SUGGESTIONS],
  };
}
