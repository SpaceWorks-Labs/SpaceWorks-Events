import { helpSections, type HelpAccess, type HelpArticleEntry, type HelpSectionEntry } from "@/content/help/manifest";
import { helpIndex } from "@/content/help/index.generated";
import type { HelpHeading, HelpSearchDocument } from "./text";

/*
 * The guide's table of contents and text, from the manifest and the generated
 * index (scripts/generate-help-index.mjs). Nothing here reads files, so the
 * same code renders the guide in the backend and in the split frontend.
 */

export type HelpArticle = HelpArticleEntry & { section: HelpSectionEntry };

const sections: readonly HelpSectionEntry[] = helpSections;
const articles: HelpArticle[] = sections.flatMap((section) => section.articles.map((article) => ({ ...article, section })));
const bySlug = new Map(articles.map((article) => [article.slug, article]));

/** Sections the viewer may read, in guide order. */
export function visibleHelpSections(access: ReadonlySet<HelpAccess>): HelpSectionEntry[] {
  return sections.filter((section) => access.has(section.access));
}

/** The article for a URL slug, only when it exists in the manifest and the viewer may read it. */
export function findHelpArticle(slug: string, access: ReadonlySet<HelpAccess>): HelpArticle | null {
  const article = bySlug.get(slug);
  return article && access.has(article.section.access) ? article : null;
}

/** The articles before and after this one in the viewer's reading order. */
export function adjacentHelpArticles(slug: string, access: ReadonlySet<HelpAccess>) {
  const readable = articles.filter((article) => access.has(article.section.access));
  const index = readable.findIndex((article) => article.slug === slug);
  return { previous: index > 0 ? readable[index - 1] : null, next: index >= 0 ? readable[index + 1] ?? null : null };
}

export function helpArticleHeadings(slug: string): readonly HelpHeading[] {
  return helpIndex[slug]?.headings ?? [];
}

/** Plain-text search documents for every article the viewer may read. */
export function helpSearchDocuments(access: ReadonlySet<HelpAccess>): HelpSearchDocument[] {
  return articles
    .filter((article) => access.has(article.section.access))
    .map((article) => ({
      slug: article.slug,
      title: article.title,
      summary: article.summary,
      section: article.section.title,
      sections: [...(helpIndex[article.slug]?.sections ?? [])],
    }));
}
