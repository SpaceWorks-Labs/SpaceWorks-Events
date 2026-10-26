import { describe, expect, it } from "vitest";
import { alignToCanvas, duplicateElement, newElement, snapBox, snapTargets } from "@/components/ticket-designer/geometry";
import { fillMergeFields, registrationNumber, SAMPLE_VALUES } from "@/lib/ticketDesign/fields";
import { CLASSIC_DESIGN, STARTER_DESIGNS } from "@/lib/ticketDesign/presets";
import { designDocumentSchema, designProblem, type DesignDocument } from "@/lib/ticketDesign/schema";

const withElements = (elements: DesignDocument["elements"]): DesignDocument => ({ ...CLASSIC_DESIGN, elements });
const qr = CLASSIC_DESIGN.elements.find((element) => element.kind === "qr")!;

describe("ticket design documents (docs/TICKET_DESIGNER.md)", () => {
  it("accepts every starter design", () => {
    for (const starter of STARTER_DESIGNS) expect(designDocumentSchema.safeParse(starter.document).success).toBe(true);
  });

  it("needs exactly one upright, solid, scannable QR code on the ticket", () => {
    expect(designProblem(withElements([]))).toBe("A ticket needs exactly one check-in QR code.");
    expect(designProblem(withElements([qr, { ...qr, id: "qr-2" }]))).toBe("A ticket needs exactly one check-in QR code.");
    expect(designProblem(withElements([{ ...qr, w: 10, h: 10 }]))).toContain("at least 18 mm");
    expect(designProblem(withElements([{ ...qr, rotation: 45 }]))).toContain("upright");
    expect(designProblem(withElements([{ ...qr, opacity: 0.5 }]))).toContain("solid");
    expect(designProblem(withElements([{ ...qr, hidden: true }]))).toContain("visible");
    expect(designProblem(withElements([{ ...qr, x: 170 }]))).toBe("Keep the whole QR code on the ticket.");
    expect(designProblem(CLASSIC_DESIGN)).toBeNull();
  });

  it("refuses unknown fonts, bad colours, duplicate ids and extra keys", () => {
    const text = CLASSIC_DESIGN.elements.find((element) => element.kind === "text")!;
    expect(designDocumentSchema.safeParse(withElements([qr, { ...text, font: "comic-sans" } as never])).success).toBe(false);
    expect(designDocumentSchema.safeParse(withElements([qr, { ...text, color: "red" }])).success).toBe(false);
    expect(designProblem(withElements([qr, text, { ...text }]))).toBe("Two elements share an id.");
    expect(designDocumentSchema.safeParse({ ...CLASSIC_DESIGN, script: "alert(1)" }).success).toBe(false);
  });
});

describe("merge fields", () => {
  it("fills known fields and drops unknown or empty ones", () => {
    expect(fillMergeFields("{{name}} · {{ team }} · {{secret}}", { name: "Asha" })).toBe("Asha ·  · ");
    expect(fillMergeFields("{{event}}", SAMPLE_VALUES)).toBe("Space Works Hack Day");
  });

  it("prints a short registration number from the id's tail", () => {
    expect(registrationNumber("cmabc123def456")).toBe("R-23DEF456");
  });
});

describe("designer geometry", () => {
  it("snaps a box to the canvas centre and other elements, with guides", () => {
    const targets = snapTargets(CLASSIC_DESIGN, "none");
    const centred = snapBox({ x: 69, y: 10, w: 40, h: 10 }, targets);
    expect(centred.box.x).toBe(70);
    expect(centred.guides).toContainEqual({ axis: "x", at: 90 });
    const free = snapBox({ x: 40.3, y: 21.7, w: 3, h: 3 }, { xs: [0], ys: [0] });
    expect(free).toEqual({ box: { x: 40.3, y: 21.7, w: 3, h: 3 }, guides: [] });
  });

  it("aligns to the canvas", () => {
    expect(alignToCanvas({ x: 5, y: 5, w: 20, h: 10 }, { widthMm: 180, heightMm: 70 }, "right")).toEqual({ x: 160, y: 5 });
    expect(alignToCanvas({ x: 5, y: 5, w: 20, h: 10 }, { widthMm: 180, heightMm: 70 }, "middle")).toEqual({ x: 5, y: 30 });
  });

  it("adds valid elements with fresh ids, and duplicates without reusing ids", () => {
    const text = newElement(CLASSIC_DESIGN, "field", { field: "team" });
    expect(text).toMatchObject({ kind: "text", text: "{{team}}", id: "text-1" });
    const copy = duplicateElement(withElements([...CLASSIC_DESIGN.elements, text]), text);
    expect(copy.id).not.toBe(text.id);
    expect(designProblem(withElements([...CLASSIC_DESIGN.elements, text, copy, newElement(CLASSIC_DESIGN, "ellipse"), newElement(CLASSIC_DESIGN, "line")]))).toBeNull();
  });
});
