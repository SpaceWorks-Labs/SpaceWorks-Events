import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { expect, type Locator, type Page } from "@playwright/test";
import { ROOT } from "./state";

/* Capture helpers: find the card around an element, screenshot a region, save the PNG and its size. */

const OUTPUT_DIR = path.join(ROOT, "public/help");
const SIZES_FILE = path.join(ROOT, "content/help/screenshots.json");

/** The nearest bordered or filled, rounded ancestor of `inner` (a card, dialog or panel). */
export async function card(inner: Locator) {
  const marker = `card-${Math.random().toString(36).slice(2)}`;
  await expect(inner.first()).toBeVisible({ timeout: 60_000 });
  await inner.first().evaluate((node, value) => {
    let element: HTMLElement | null = node as HTMLElement;
    while (element && element !== document.body) {
      const style = getComputedStyle(element);
      const filled = style.backgroundColor !== "rgba(0, 0, 0, 0)" && style.backgroundColor !== "transparent";
      if ((parseFloat(style.borderTopWidth) > 0 || filled) && parseFloat(style.borderTopLeftRadius) >= 8 && element.offsetWidth >= 240) break;
      element = element.parentElement;
    }
    (element && element !== document.body ? element : (node as HTMLElement)).setAttribute("data-help-card", value);
  }, marker);
  return inner.page().locator(`[data-help-card="${marker}"]`);
}

/** A locator that keeps matching `inner` even after the page hides it from the accessibility tree (an open menu). */
export async function mark(inner: Locator) {
  const marker = `mark-${Math.random().toString(36).slice(2)}`;
  await inner.first().evaluate((node, value) => (node as HTMLElement).setAttribute("data-help-mark", value), marker);
  return inner.page().locator(`[data-help-mark="${marker}"]`);
}

type CaptureOptions = { pad?: number; padTop?: number; maxHeight?: number; fullWidth?: boolean };

/** Screenshots the union of `targets` (plus padding) and records the PNG's size. */
export async function capture(page: Page, name: string, targets: Locator | Locator[], options: CaptureOptions = {}) {
  const { pad = 16, padTop = pad, maxHeight } = options;
  const list = Array.isArray(targets) ? targets : [targets];
  for (const target of list) await expect(target.first()).toBeVisible({ timeout: 60_000 });
  // Let images, fonts and transitions settle before measuring.
  await page.evaluate(() => document.fonts.ready);
  await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
  await page.waitForTimeout(600);
  await page.evaluate(() => window.scrollTo(0, 0));
  const scroll = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY, width: document.documentElement.scrollWidth }));
  const boxes = [];
  for (const target of list) {
    const box = await target.first().boundingBox();
    if (!box) throw new Error(`${name}: target has no box`);
    boxes.push({ x: box.x + scroll.x, y: box.y + scroll.y, right: box.x + scroll.x + box.width, bottom: box.y + scroll.y + box.height });
  }
  const x = options.fullWidth ? 0 : Math.max(0, Math.floor(Math.min(...boxes.map((box) => box.x)) - pad));
  const y = Math.max(0, Math.floor(Math.min(...boxes.map((box) => box.y)) - padTop));
  const right = options.fullWidth ? scroll.width : Math.min(scroll.width, Math.ceil(Math.max(...boxes.map((box) => box.right)) + pad));
  let height = Math.ceil(Math.max(...boxes.map((box) => box.bottom)) + pad) - y;
  if (maxHeight) height = Math.min(height, maxHeight);
  const raw = await page.screenshot({ clip: { x, y, width: right - x, height }, fullPage: true, animations: "disabled", caret: "hide" });
  await save(name, raw);
}

/** A dashboard tab panel already has top padding of its own. */
export const capturePanel = (page: Page, name: string, panel: Locator, options: CaptureOptions = {}) => capture(page, name, panel, { padTop: 0, ...options });

/** Makes the viewport as tall as the page, so bars stuck to the bottom sit where they belong and menus open downwards. */
export async function tallViewport(page: Page, height?: number) {
  const pageHeight = await page.evaluate(() => document.documentElement.scrollHeight);
  await page.setViewportSize({ width: 1280, height: height ?? pageHeight });
}

export const resetViewport = (page: Page) => page.setViewportSize({ width: 1280, height: 800 });

/** Captures exactly what the viewport shows. */
export async function captureViewport(page: Page, name: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(600);
  await save(name, await page.screenshot({ animations: "disabled", caret: "hide" }));
}

async function save(name: string, raw: Buffer) {
  // A 256-colour palette keeps UI screenshots small and visually lossless.
  const png = await sharp(raw).png({ palette: true, quality: 95, effort: 10, compressionLevel: 9 }).toBuffer();
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUTPUT_DIR, `${name}.png`), png);
  const { width, height } = await sharp(png).metadata();
  const sizes = fs.existsSync(SIZES_FILE) ? (JSON.parse(fs.readFileSync(SIZES_FILE, "utf8")) as Record<string, { width: number; height: number }>) : {};
  sizes[name] = { width: width!, height: height! };
  const sorted = Object.fromEntries(Object.entries(sizes).sort(([a], [b]) => a.localeCompare(b)));
  fs.writeFileSync(SIZES_FILE, `${JSON.stringify(sorted, null, 2)}\n`);
}

export const heading = (scope: Page | Locator, name: string | RegExp) => scope.getByRole("heading", { name, exact: typeof name === "string" }).first();
export const visibleTabPanel = (page: Page) => page.getByRole("tabpanel").filter({ visible: true }).first();
/** The inner (sub-tab) panel of a dashboard tab. */
export const innerTabPanel = (page: Page) => visibleTabPanel(page).getByRole("tabpanel").filter({ visible: true }).first();

/** Clicks a (sub-)tab by its accessible name and waits for its panel. */
export async function openTab(page: Page, name: string | RegExp) {
  await page.getByRole("tab", { name }).filter({ visible: true }).first().click();
  await page.waitForTimeout(300);
}
