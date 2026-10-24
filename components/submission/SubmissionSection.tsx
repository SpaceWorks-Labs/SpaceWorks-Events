import type { SubmissionRef } from "@/app/actions/submissions";
import { SubmissionEditor, type SubmissionEditorView } from "./SubmissionEditor";

/**
 * The entrant's submission editor. Its view comes from the page's reader
 * (lib/submissionEditorView.ts); nothing renders when there is none.
 */
export function SubmissionSection({
  view,
  submissionRef,
  variant = "card",
}: {
  view: SubmissionEditorView | null;
  submissionRef: SubmissionRef;
  /** `page` renders the event title as the page heading (`/submit/{token}`, account page). */
  variant?: "card" | "page";
}) {
  if (!view) return null;
  return <SubmissionEditor submissionRef={submissionRef} view={view} variant={variant} />;
}
