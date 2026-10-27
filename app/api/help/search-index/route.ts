import { NextResponse } from "next/server";
import { loadHelpAccess } from "@/lib/views/app__help__layout";
import { helpSearchDocuments } from "@/lib/help/content";

/**
 * Plain text of every guide article the viewer may read, searched in the
 * browser by components/help/HelpSearch.tsx. Restricted sections are only
 * included for viewers who can open them, so the response is never shared or
 * stored (the split frontend's API proxy passes this header through).
 */
export async function GET() {
  const access = new Set(await loadHelpAccess());
  return NextResponse.json({ documents: helpSearchDocuments(access) }, { headers: { "Cache-Control": "private, no-store" } });
}
