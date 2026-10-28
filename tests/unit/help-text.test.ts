import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractHeadings, extractSearchSections, headingId, searchHelp } from "@/lib/help/text";
import { buildHelpBodiesSource, buildHelpIndexSource, helpIndexIsCurrent } from "../../scripts/generate-help-index.mjs";

describe("guide text helpers", () => {
  it("builds anchors from heading text", () => {
    expect(headingId("Who can see it?")).toBe("who-can-see-it");
    expect(headingId("Capacity & the waitlist")).toBe("capacity-and-the-waitlist");
    expect(headingId("The `{{name}}` placeholder")).toBe("the-name-placeholder");
    expect(headingId("Café réunion")).toBe("cafe-reunion");
  });

  it("extracts headings outside code fences", () => {
    const source = "Intro\n\n## First **step**\n\n```md\n## Not a heading\n```\n\n### Detail";
    expect(extractHeadings(source)).toEqual([
      { id: "first-step", title: "First step", level: 2 },
      { id: "detail", title: "Detail", level: 3 },
    ]);
  });

  it("turns MDX into searchable sections without markup", () => {
    const source = "Open [the guide](/help).\n\n## Publish\n\n<Callout kind=\"tip\">\n\nPress **Publish**.\n\n</Callout>\n\n<Screenshot name=\"x\" alt=\"y\" />";
    expect(extractSearchSections(source)).toEqual([
      { heading: null, anchor: null, text: "Open the guide." },
      { heading: "Publish", anchor: "publish", text: "Press Publish." },
    ]);
  });

  it("ranks title matches first and requires every term", () => {
    const documents = [
      { slug: "a/one", title: "Check-in desk", summary: "Scan tickets", section: "Check-in", sections: [{ heading: null, anchor: null, text: "Scan a QR ticket at the door." }] },
      { slug: "a/two", title: "Your ticket", summary: "Open your ticket", section: "Attending", sections: [{ heading: "Download", anchor: "download", text: "Download the ticket as a PDF." }] },
    ];
    expect(searchHelp(documents, "ticket").map((result) => result.slug)).toEqual(["a/two", "a/one"]);
    expect(searchHelp(documents, "ticket door").map((result) => result.slug)).toEqual(["a/one"]);
    expect(searchHelp(documents, "download")[0]).toMatchObject({ slug: "a/two", anchor: "download" });
    expect(searchHelp(documents, "   ")).toEqual([]);
  });
});

describe("generated guide index", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  function contentRoot() {
    dir = mkdtempSync(path.join(tmpdir(), "help-index-"));
    mkdirSync(path.join(dir, "events"));
    writeFileSync(path.join(dir, "events", "create.mdx"), "Intro text.\n\n## Make one\n\nChoose **Create event**.\n");
    return dir;
  }

  it("indexes headings and search text, and loads each body with a static import", async () => {
    const root = contentRoot();
    const index = await buildHelpIndexSource(root);
    expect(index).toContain('"events/create"');
    expect(index).toContain('"id": "make-one"');
    expect(index).toContain('"text": "Choose Create event."');
    expect(buildHelpBodiesSource(root)).toContain('"events/create": () => import("./events/create.mdx"),');
  });

  it("reports a stale index until it is regenerated (the --check mode)", async () => {
    const root = contentRoot();
    expect(await helpIndexIsCurrent(root)).toBe(false);
    writeFileSync(path.join(root, "index.generated.ts"), await buildHelpIndexSource(root));
    writeFileSync(path.join(root, "bodies.generated.ts"), buildHelpBodiesSource(root));
    expect(await helpIndexIsCurrent(root)).toBe(true);
    // Line endings from a Windows checkout don't count as a change.
    writeFileSync(path.join(root, "index.generated.ts"), (await buildHelpIndexSource(root)).replace(/\n/g, "\r\n"));
    expect(await helpIndexIsCurrent(root)).toBe(true);
    writeFileSync(path.join(root, "events", "create.mdx"), "Intro text.\n\n## Make one now\n");
    expect(await helpIndexIsCurrent(root)).toBe(false);
    writeFileSync(path.join(root, "events", "new.mdx"), "New.\n");
    writeFileSync(path.join(root, "index.generated.ts"), await buildHelpIndexSource(root));
    expect(await helpIndexIsCurrent(root)).toBe(false);
  });
});
