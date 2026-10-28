import { NextResponse } from "next/server";
import { assetLinksStatement } from "@/lib/mobile/appLinks";

export const dynamic = "force-dynamic";

/** Android App Links verification (package from ANDROID_APP_PACKAGE_NAME, read at runtime). */
export function GET() {
  return NextResponse.json(assetLinksStatement(), { headers: { "Cache-Control": "public, max-age=300" } });
}
