import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { helpSections } from "@/content/help/manifest";
import screenshots from "@/content/help/screenshots.json";
import { extractHeadings } from "@/lib/help/text";
import { helpIndexIsCurrent } from "../../scripts/generate-help-index.mjs";

const root = path.join(process.cwd(), "content", "help");
const articles = helpSections.flatMap((section) => section.articles.map((article) => ({ ...article, access: section.access })));
const sources = new Map<string, string>(articles.map((article) => [article.slug, readFileSync(path.join(root, `${article.slug}.mdx`), "utf8")]));
const anchors = new Map<string, Set<string>>(articles.map((article) => [article.slug, new Set(extractHeadings(sources.get(article.slug)!).map((heading) => heading.id))]));
const access = new Map<string, string>(articles.map((article) => [article.slug, article.access]));
const allowedComponents = new Set(["Callout", "Steps", "Kbd", "Screenshot"]);

function files(dir: string, test: (name: string) => boolean): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : files(full, test);
    return test(entry.name) ? [full] : [];
  });
}

/** Strips fenced code so examples inside it are not checked as content. */
function prose(source: string): string {
  return source.replace(/^```[\s\S]*?^```/gm, "");
}

describe("guide manifest", () => {
  it("has unique slugs and section ids", () => {
    const slugs = articles.map((article) => article.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    const ids = helpSections.map((section) => section.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("matches the MDX files one to one", () => {
    const mdx = files(root, (name) => name.endsWith(".mdx")).map((file) => path.relative(root, file).replace(/\\/g, "/").replace(/\.mdx$/, ""));
    expect(mdx.sort()).toEqual(articles.map((article) => article.slug).sort());
  });

  it("keeps slugs to safe path segments inside their own section", () => {
    for (const section of helpSections) {
      for (const article of section.articles) expect(article.slug).toMatch(new RegExp(`^${section.id}/[a-z0-9-]+$`));
    }
  });

  it("has a current generated index (npm run help:index)", async () => {
    expect(await helpIndexIsCurrent()).toBe(true);
  });
});

describe("guide articles", () => {
  it.each(articles.map((article) => [article.slug]))("%s is well formed", (slug) => {
    const source = sources.get(slug)!;
    const body = prose(source);
    expect(body, "write the title in the section file, not as a # heading").not.toMatch(/^#\s/m);
    expect(body, "use <Screenshot>, not Markdown images").not.toMatch(/!\[[^\]]*\]\(/);
    expect(body).not.toMatch(/^(import|export)\s/m);
    // Inline code may hold a repository URL (SpaceWorks-Labs/...); prose may not.
    expect(body.replace(/`[^`\n]*`/g, ""), "write Space Works, never SpaceWorks or Yuyu").not.toMatch(/SpaceWorks|Yuyu/);
    expect(body).not.toMatch(/\bOops\b|Something went wrong/);

    const ids = extractHeadings(source).map((heading) => heading.id);
    expect(new Set(ids).size, "headings must be unique within an article").toBe(ids.length);

    for (const [, name] of body.matchAll(/<([A-Z][A-Za-z]*)/g)) {
      expect(allowedComponents.has(name), `unknown component <${name}>`).toBe(true);
    }
  });

  it("links only to articles and sections that exist, readable by the same audience", () => {
    const problems: string[] = [];
    for (const article of articles) {
      for (const [, target] of prose(sources.get(article.slug)!).matchAll(/\]\((\/help[^)\s]*)\)/g)) {
        const [pathname, anchor] = target.split("#");
        const slug = pathname.replace(/^\/help\/?/, "");
        if (slug === "") continue;
        if (!access.has(slug)) problems.push(`${article.slug} → ${target}: no such article`);
        else if (anchor && !anchors.get(slug)!.has(anchor)) problems.push(`${article.slug} → ${target}: no such section`);
        else if (article.access === "public" && access.get(slug) !== "public") problems.push(`${article.slug} → ${target}: public page links to a restricted one`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("uses only captured screenshots", () => {
    const known: Record<string, { width: number; height: number }> = screenshots;
    const problems: string[] = [];
    for (const [slug, source] of sources) {
      for (const [, name] of source.matchAll(/<Screenshot\s+name="([^"]+)"/g)) {
        if (!/^[a-z0-9-]+$/.test(name)) problems.push(`${slug}: bad name ${name}`);
        else if (!known[name]) problems.push(`${slug}: ${name} is not in screenshots.json`);
        else if (!existsSync(path.join(process.cwd(), "public", "help", `${name}.png`))) problems.push(`${slug}: public/help/${name}.png is missing`);
      }
    }
    expect(problems).toEqual([]);
  });
});

describe("contextual help links", () => {
  const sourcesWithLinks = ["app", "components"].flatMap((dir) => files(path.join(process.cwd(), dir), (name) => /\.tsx?$/.test(name)))
    .map((file) => ({ file: path.relative(process.cwd(), file), source: readFileSync(file, "utf8") }))
    .filter(({ source }) => source.includes("<HelpLink"));

  it("are placed on the dashboard screens", () => {
    expect(sourcesWithLinks.length).toBeGreaterThan(20);
  });

  it("point at articles and sections that exist", () => {
    const problems: string[] = [];
    for (const { file, source } of sourcesWithLinks) {
      for (const [tag] of source.matchAll(/<HelpLink\b[^>]*>/g)) {
        const article = /article="([^"]+)"/.exec(tag)?.[1];
        const section = /section="([^"]+)"/.exec(tag)?.[1];
        if (!article) problems.push(`${file}: HelpLink without a literal article`);
        else if (!access.has(article)) problems.push(`${file}: ${article} is not an article`);
        else if (section && !anchors.get(article)!.has(section)) problems.push(`${file}: ${article}#${section} is not a section`);
      }
    }
    expect(problems).toEqual([]);
  });
});
