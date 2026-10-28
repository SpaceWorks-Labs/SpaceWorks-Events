import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { certificateTemplateInputSchema, certificateTemplateSchema, defaultNameArea, defaultNameElement, fillCertificateText, parseCertificateTemplate, type CertificateTemplate } from "@/lib/certificateTemplate";
const mocks = vi.hoisted(() => ({ download: vi.fn() }));
vi.mock("@/lib/storage", () => ({ downloadFile: mocks.download }));
import { certificateKeysBelongTo, renderCustomCertificate } from "@/lib/renderCertificate";

const backgroundKey = "organisations/org_1/certificate-backgrounds/12345678-1234-4123-8123-123456789abc.webp";
const assetKey = "organisations/org_1/certificate-assets/87654321-1234-4123-8123-123456789abc.webp";
const legacy = { ...defaultNameArea, backgroundKey };
const template: CertificateTemplate = { version: 2, backgroundKey, elements: [defaultNameElement()] };
const values = { name: "Alex", event: "Launch night", eventDate: "14 Oct 2026", organisation: "Community", issueDate: "15 Oct 2026", role: "", hours: "" };
const withName = (patch: Record<string, unknown>) => ({ ...template, elements: [{ ...template.elements[0], ...patch }] });

/** Bounding box of dark pixels as fractions of the image. */
async function inkBounds(jpeg: Buffer, test: (r: number, g: number, b: number) => boolean) {
  const { data, info } = await sharp(jpeg).raw().toBuffer({ resolveWithObject: true });
  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
  for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
    const o = (y * info.width + x) * info.channels;
    if (test(data[o]!, data[o + 1]!, data[o + 2]!)) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  }
  return maxX < 0 ? null : { left: minX / info.width, right: maxX / info.width, top: minY / info.height, bottom: maxY / info.height };
}

describe("certificate templates", () => {
  it("rejects remote images, unsupported fonts, injected colors, and out-of-bounds layers", () => {
    for (const patch of [{ font: "Comic Sans" }, { color: 'red" onload="alert(1)' }, { x: 95 }, { height: 90 }, { width: 0 }, { fontSize: Infinity }, { text: "" }, { letterSpacing: 99 }]) {
      expect(certificateTemplateSchema.safeParse(withName(patch)).success).toBe(false);
    }
    expect(certificateTemplateSchema.safeParse({ ...template, backgroundKey: "https://example.com/a.png" }).success).toBe(false);
    const image = { id: "logo", type: "image", key: "https://example.com/logo.png", label: "Logo", x: 0, y: 0, width: 10, height: 10 };
    expect(certificateTemplateSchema.safeParse({ ...template, elements: [image] }).success).toBe(false);
    expect(certificateTemplateSchema.safeParse({ ...template, elements: [template.elements[0], template.elements[0]] }).success).toBe(false);
    expect(certificateTemplateSchema.safeParse({ ...template, elements: Array.from({ length: 21 }, (_, i) => ({ ...template.elements[0], id: `t${i}` })) }).success).toBe(false);
  });

  it("upgrades the legacy single name area", () => {
    expect(parseCertificateTemplate(legacy)).toEqual({ version: 2, backgroundKey, elements: [{ id: "name", type: "text", text: "{{name}}", x: 15, y: 43, width: 70, height: 14, font: "serif", fontSize: 48, color: "#16243a", bold: false, align: "center", italic: false, uppercase: false, letterSpacing: 0 }] });
    expect(certificateTemplateInputSchema.safeParse(template).success).toBe(true);
    expect(parseCertificateTemplate({ ...legacy, x: 95 })).toBeNull();
  });

  it("fills merge tags as plain text and leaves unknown tags alone", () => {
    expect(fillCertificateText("{{ name }} · {{event}} on {{eventDate}} ({{unknown}})", { ...values, name: "A\nB" })).toBe("A B · Launch night on 14 Oct 2026 ({{unknown}})");
  });

  it("checks every key belongs to the organisation", () => {
    const foreign = { ...template, elements: [{ id: "logo", type: "image" as const, key: assetKey.replace("org_1", "org_2"), label: "Logo", x: 0, y: 0, width: 10, height: 10 }] };
    expect(certificateKeysBelongTo(template, "org_1")).toBe(true);
    expect(certificateKeysBelongTo(foreign, "org_1")).toBe(false);
  });

  it("rejects images from another tenant before fetching them", async () => {
    mocks.download.mockClear();
    await expect(renderCustomCertificate(template, values, "org_2")).rejects.toThrow("Invalid certificate image");
    expect(mocks.download).not.toHaveBeenCalled();
  });

  it.each(["serif", "sans", "mono"] as const)("renders %s and fits long text inside its layer", async (font) => {
    const background = await sharp({ create: { width: 1000, height: 700, channels: 3, background: "#fff" } }).webp().toBuffer();
    mocks.download.mockResolvedValue({ body: background });
    const long = { ...values, name: "A very long participant name <&> ".repeat(2) };
    const jpeg = await renderCustomCertificate(withName({ font, width: 40, height: 5, italic: true, letterSpacing: 10 }) as CertificateTemplate, long, "org_1");
    expect(await sharp(jpeg).metadata()).toMatchObject({ width: 3508, height: 2456, format: "jpeg", density: 300 });
    const ink = (await inkBounds(jpeg, (r) => r < 150))!;
    expect(ink.left).toBeGreaterThanOrEqual(0.149);
    expect(ink.right).toBeLessThanOrEqual(0.551);
    expect(ink.top).toBeGreaterThanOrEqual(0.429);
    expect(ink.bottom).toBeLessThanOrEqual(0.481);
  });

  it("renders several text layers and an image layer in their boxes", async () => {
    const background = await sharp({ create: { width: 1000, height: 700, channels: 3, background: "#fff" } }).webp().toBuffer();
    const logo = await sharp({ create: { width: 200, height: 100, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } } }).webp({ lossless: true }).toBuffer();
    mocks.download.mockImplementation(async (key: string) => ({ body: key === assetKey ? logo : background }));
    const jpeg = await renderCustomCertificate({
      version: 2, backgroundKey,
      elements: [
        { ...defaultNameElement(), x: 10, y: 10, width: 30, height: 10, color: "#000000" },
        { ...defaultNameElement("title"), text: "{{event}}\n{{eventDate}}", x: 10, y: 60, width: 30, height: 20, color: "#0000ff", uppercase: true },
        { id: "logo", type: "image", key: assetKey, label: "Logo", x: 70, y: 70, width: 20, height: 20 },
      ],
    }, values, "org_1");
    const red = (await inkBounds(jpeg, (r, g, b) => r > 200 && g < 60 && b < 60))!;
    // 200×100 logo contained in a 20%×20% box of a 10:7 image: full width, centred vertically.
    expect(red.left).toBeCloseTo(0.7, 2);
    expect(red.right).toBeCloseTo(0.9, 2);
    expect(red.top).toBeGreaterThan(0.7);
    expect(red.bottom).toBeLessThan(0.9);
    const blue = (await inkBounds(jpeg, (r, g, b) => b > 150 && r < 100 && g < 100))!;
    expect(blue.top).toBeGreaterThanOrEqual(0.599);
    expect(blue.bottom).toBeLessThanOrEqual(0.801);
    const black = (await inkBounds(jpeg, (r, g, b) => r < 80 && g < 80 && b < 80))!;
    expect(black.top).toBeGreaterThanOrEqual(0.099);
    expect(black.bottom).toBeLessThanOrEqual(0.201);
  });
});
