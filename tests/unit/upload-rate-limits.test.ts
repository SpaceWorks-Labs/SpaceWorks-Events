import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Event page images have their own hourly budget, so building a page with
// dozens of speaker photos never uses up the shared upload budget that
// certificates, member IDs and ticket designs draw on (and the reverse).

afterEach(() => vi.unstubAllEnvs());

async function limiter() {
  vi.resetModules();
  vi.stubEnv("REDIS_URL", "");
  return import("@/lib/rateLimit");
}

async function allowed(check: (bucket: "upload" | "eventPageUpload" | "crewPhotoUpload" | "crewPhotoUploadEvent", id: string) => Promise<boolean>, bucket: "upload" | "eventPageUpload" | "crewPhotoUpload" | "crewPhotoUploadEvent", id: string, times: number) {
  let count = 0;
  for (let index = 0; index < times; index += 1) if (await check(bucket, id)) count += 1;
  return count;
}

describe("upload rate-limit buckets", () => {
  it("allows 60 event page images an hour, separately from 12 other uploads", async () => {
    const { checkRateLimitById } = await limiter();
    expect(await allowed(checkRateLimitById, "eventPageUpload", "user_1", 70)).toBe(60);
    expect(await allowed(checkRateLimitById, "upload", "user_1", 20)).toBe(12);
  });

  it("gives crew-link photos their own budget, so they never use the shared upload budget", async () => {
    const { checkRateLimitById } = await limiter();
    expect(await allowed(checkRateLimitById, "crewPhotoUpload", "subject:link", 70)).toBe(60);
    expect(await allowed(checkRateLimitById, "upload", "subject:link", 20)).toBe(12);
  });

  it("caps crew-link photos at 200 a day per event, whoever uploads them", async () => {
    const { checkRateLimitById } = await limiter();
    expect(await allowed(checkRateLimitById, "crewPhotoUploadEvent", "event:e1", 210)).toBe(200);
    expect(await allowed(checkRateLimitById, "crewPhotoUploadEvent", "event:e2", 5)).toBe(5);
  });
});

// Which bucket each upload action spends (read from the source, so a moved
// or new upload action has to be placed here deliberately).
type Bucket = "upload" | "eventPageUpload" | "crewPhotoUpload" | "crewPhotoUploadEvent";
const UPLOAD_ACTIONS: Record<string, { file: string; buckets?: Bucket[]; via?: string }> = {
  uploadCrewPhoto: { file: "app/actions/crew.ts", buckets: ["eventPageUpload"] },
  uploadCrewPhotoWithLink: { file: "app/actions/crew.ts", buckets: ["crewPhotoUpload", "crewPhotoUploadEvent"] },
  uploadEventSpeakerPhoto: { file: "app/actions/event-website/uploads.ts", buckets: ["eventPageUpload"] },
  uploadEventSponsorLogo: { file: "app/actions/event-website/uploads.ts", buckets: ["eventPageUpload"] },
  uploadEventCoverImage: { file: "app/actions/event.ts", buckets: ["eventPageUpload"] },
  uploadEventPageLogo: { file: "app/actions/media.ts", buckets: ["eventPageUpload"] },
  uploadOrganisationLogo: { file: "app/actions/media.ts", buckets: ["upload"] },
  uploadAccountProfileImage: { file: "app/actions/media.ts", buckets: ["upload"] },
  // Through the certificate access check, `requireProgramme(…, "upload")` and the ticket-design `actor(…, "upload")`.
  uploadCertificateBackground: { file: "app/actions/certificate.ts", via: "uploadCertificateImage" },
  uploadCertificateAsset: { file: "app/actions/certificate.ts", via: "uploadCertificateImage" },
  uploadIdProgrammeWatermark: { file: "app/actions/member-ids.ts", via: "requireProgramme(" },
  uploadIdMemberPhoto: { file: "app/actions/member-ids.ts", via: "requireProgramme(" },
  uploadTicketDesignImageAction: { file: "app/actions/ticket-designs.ts", via: "actor(" },
};

/** The source of one top-level function, up to the next top-level declaration. */
function functionSource(file: string, name: string): string {
  const source = readFileSync(join(process.cwd(), file), "utf8");
  const start = source.search(new RegExp(`^(export )?async function ${name}\\(`, "m"));
  if (start < 0) throw new Error(`${name} not found in ${file}`);
  const rest = source.slice(start + 1);
  const end = rest.search(/^(export |async |function |const |\/\*\*)/m);
  return end < 0 ? rest : rest.slice(0, end);
}

const bucketsIn = (body: string) => [...body.matchAll(/(?:isActionRateLimited|checkRateLimitById)\("(\w+)"/g)].map((match) => match[1]).sort();

describe("which bucket each upload action uses", () => {
  it("spends the event page budget on event page and crew images, and the shared budget on the rest", () => {
    for (const [name, expected] of Object.entries(UPLOAD_ACTIONS)) {
      const body = functionSource(expected.file, name);
      if (expected.buckets) expect(bucketsIn(body), name).toEqual([...expected.buckets].sort());
      else expect(body, name).toContain(expected.via);
    }
    expect(bucketsIn(functionSource("app/actions/certificate.ts", "access"))).toEqual(["upload"]);
    expect(functionSource("app/actions/member-ids.ts", "uploadIdProgrammeWatermark")).toContain('"upload")');
    expect(functionSource("app/actions/member-ids.ts", "uploadIdMemberPhoto")).toContain('"upload")');
    expect(functionSource("app/actions/ticket-designs.ts", "uploadTicketDesignImageAction")).toContain('"upload")');
    // A member ID join's photo spends the shared budget on top of the join attempt.
    expect(bucketsIn(functionSource("app/actions/member-id-join.ts", "joinIdProgramme"))).toEqual(["rsvp", "upload"]);
  });

  it("lists every upload action", () => {
    const root = join(process.cwd(), "app/actions");
    const files = readdirSync(root, { recursive: true, encoding: "utf8" }).filter((file) => file.endsWith(".ts"));
    const declared = files.flatMap((file) => [...readFileSync(join(root, file), "utf8").matchAll(/^export async function (upload\w*)\(/gm)].map((match) => match[1]!));
    expect([...new Set(declared)].sort()).toEqual(Object.keys(UPLOAD_ACTIONS).sort());
  });
});
