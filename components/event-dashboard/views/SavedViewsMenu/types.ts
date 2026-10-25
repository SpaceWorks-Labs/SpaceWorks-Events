import type { SavedViewsActionData } from "@/app/actions/saved-views";

export type ActionResult = { ok: true; data?: SavedViewsActionData } | { ok: false; error: string; fieldErrors?: Record<string, string[]> };
