import type { CrewKind } from "@prisma/client";

/**
 * Crew kinds (docs/VOLUNTEERS.md): what a crew member does, for display,
 * badges and filters only. A kind never grants authority; that comes from
 * collaborator grants or shift sign-ups. Safe for client components.
 */
export const CREW_KINDS = ["ORGANISER", "VOLUNTEER", "MENTOR", "JUDGE"] as const satisfies readonly CrewKind[];

export const CREW_KIND_LABELS: Record<CrewKind, string> = {
  ORGANISER: "Organiser",
  VOLUNTEER: "Volunteer",
  MENTOR: "Mentor",
  JUDGE: "Judge",
};

/** The label for a kind, or "Crew" when it is unknown. */
export function crewKindLabel(kind: CrewKind | null | undefined): string {
  return kind ? CREW_KIND_LABELS[kind] : "Crew";
}
