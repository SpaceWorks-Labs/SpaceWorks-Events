import "server-only";
import { cache } from "react";
import { loadHelpAccess } from "@/lib/views/app__help__layout";
import type { HelpAccess } from "@/content/help/manifest";

/**
 * The guide sections the current visitor may read, resolved by the backend
 * view reader (lib/views/app__help__layout.ts) and cached per request because
 * the layout, the page and its metadata all ask. A reading convenience only.
 */
export const helpAccessForViewer = cache(async (): Promise<ReadonlySet<HelpAccess>> => new Set(await loadHelpAccess()));
