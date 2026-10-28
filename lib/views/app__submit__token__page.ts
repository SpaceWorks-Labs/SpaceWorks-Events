import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { resolveEntrantBySubmissionLink } from "@/lib/core/judging";
import { isSubmissionTokenShape } from "@/lib/submissionToken";
import { loadSubmissionEditorView } from "@/lib/submissionEditorView";

/**
 * A solo registrant's project page by its emailed link (docs/HACKATHON.md). A
 * malformed, retired or foreign token, or an event that does not take
 * submissions, is a plain 404.
 */
export async function loadSubmitView({ params }: { params: Promise<{ token: string; }>; }) {
  const { token } = await params;
  const raw = token?.trim() ?? "";
  if (!isSubmissionTokenShape(raw)) notFound();
  const entrant = await resolveEntrantBySubmissionLink(raw);
  if (!entrant) notFound();
  const [view, accent] = await Promise.all([
    loadSubmissionEditorView(entrant),
    prisma.event.findUnique({ where: { id: entrant.eventId }, select: { page: { select: { accentColor: true } } } }),
  ]);
  if (!view) notFound();
  return { view, submissionToken: raw, accentColor: accent?.page?.accentColor ?? null };
}
