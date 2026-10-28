"use client";

import { useState, type KeyboardEvent } from "react";
import { ImagePlus, Type, Upload } from "lucide-react";
import { Button, buttonClasses } from "@/components/ui/button";
import { Callout } from "@/components/ui/display";
import { Field, Input } from "@/components/ui/field";
import { cn } from "@/lib/cn";
import {
  CONTRIBUTOR_MERGE_TAGS,
  certificateMergeTags,
  defaultNameElement,
  type CertificateElement,
  type CertificateMergeTag,
  type CertificateTemplate,
} from "@/lib/certificateTemplate";
import { previewCertificate, uploadCertificateAsset, uploadCertificateBackground } from "@/app/actions/certificate";
import { CertificateCanvas } from "./certificate/CertificateCanvas";
import { LayerInspector } from "./certificate/LayerInspector";
import { LayersPanel } from "./certificate/LayersPanel";
import {
  clampBox,
  formatIssueDate,
  imageBox,
  loadImageSize,
  MAX_LAYERS,
  newLayerId,
  newTextElement,
  sampleValues,
  uploadUrl,
  usesNameTag,
  type Size,
} from "./certificate/layers";

type Props = {
  organisationSlug: string; eventId: string;
  value: CertificateTemplate | null;
  onChange: (value: CertificateTemplate | null) => void;
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
  /** Sample values for the layout preview only; downloads use the real values. */
  eventTitle?: string;
  eventDateLabel?: string;
  organisationName?: string;
  /** A contributor certificate (docs/VOLUNTEERS.md): offers the role and hours tags. */
  contributor?: boolean;
};

const isTyping = (target: EventTarget) => target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
const labelFromFile = (file: File) => file.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim().slice(0, 60) || "Image";

export function CertificateBuilder(props: Props) {
  const { value, onChange, disabled } = props;
  const [dimensions, setDimensions] = useState<Size>({ width: 1600, height: 1130 });
  const [name, setName] = useState<string>(certificateMergeTags.name.sample);
  const [issueDate] = useState(() => formatIssueDate(new Date()));
  const [selectedId, setSelectedId] = useState<string | null>(() => value?.elements.at(-1)?.id ?? null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const busyOrDisabled = disabled || busy;
  const values = sampleValues({ name, eventTitle: props.eventTitle, eventDateLabel: props.eventDateLabel, organisationName: props.organisationName, issueDate });

  const update = (next: CertificateTemplate | null) => { setPreview(null); onChange(next); };
  const setElements = (elements: CertificateElement[]) => { if (value) update({ ...value, elements }); };
  const changeElement = (id: string, patch: Partial<CertificateElement>) => {
    if (!value) return;
    setElements(value.elements.map((element) => {
      if (element.id !== id) return element;
      const merged = { ...element, ...patch } as CertificateElement;
      return { ...merged, ...clampBox(merged) };
    }));
  };
  const setWorking = (working: boolean) => { setBusy(working); props.onBusyChange(working); };
  const selected = value?.elements.find((element) => element.id === selectedId) ?? null;
  const atLimit = (value?.elements.length ?? 0) >= MAX_LAYERS;

  async function uploadFile(action: typeof uploadCertificateBackground, file: File): Promise<string | null> {
    const form = new FormData();
    form.set("file", file); form.set("organisationSlug", props.organisationSlug); form.set("eventId", props.eventId);
    const result = await action(form);
    if (!result.ok) { setError(result.error); return null; }
    return result.data!.key;
  }

  async function run(task: () => Promise<void>, failure: string) {
    setError(""); setWorking(true);
    try { await task(); } catch { setError(failure); } finally { setWorking(false); }
  }

  const uploadBackground = (file: File) => run(async () => {
    const key = await uploadFile(uploadCertificateBackground, file);
    if (!key) return;
    if (value) { update({ ...value, backgroundKey: key }); return; }
    const first = defaultNameElement();
    update({ version: 2, backgroundKey: key, elements: [first] });
    setSelectedId(first.id);
  }, "Upload failed. Please try again.");

  const addImage = (file: File) => run(async () => {
    if (!value || atLimit) return;
    const key = await uploadFile(uploadCertificateAsset, file);
    if (!key) return;
    const natural = await loadImageSize(uploadUrl(key)).catch(() => ({ width: 1, height: 1 }));
    const id = newLayerId("i", value.elements);
    update({ ...value, elements: [...value.elements, { id, type: "image", key, label: labelFromFile(file), ...imageBox(natural, dimensions) }] });
    setSelectedId(id);
  }, "Upload failed. Please try again.");

  const replaceImage = (id: string, file: File) => run(async () => {
    const current = value?.elements.find((element) => element.id === id);
    if (!value || current?.type !== "image") return;
    const key = await uploadFile(uploadCertificateAsset, file);
    if (!key) return;
    const natural = await loadImageSize(uploadUrl(key)).catch(() => ({ width: 1, height: 1 }));
    const box = imageBox(natural, dimensions, current.width, current.x + current.width / 2, current.y + current.height / 2);
    setElements(value.elements.map((element) => (element.id === id ? { ...current, key, ...box } : element)));
  }, "Upload failed. Please try again.");

  function addText() {
    if (!value || atLimit) return;
    const element = newTextElement(newLayerId("t", value.elements));
    setElements([...value.elements, element]);
    setSelectedId(element.id);
  }

  function moveLayer(id: string, direction: 1 | -1) {
    if (!value) return;
    const from = value.elements.findIndex((element) => element.id === id);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= value.elements.length) return;
    const elements = [...value.elements];
    [elements[from], elements[to]] = [elements[to]!, elements[from]!];
    setElements(elements);
  }

  function duplicateLayer(id: string) {
    if (!value || atLimit) return;
    const index = value.elements.findIndex((element) => element.id === id);
    const source = value.elements[index];
    if (!source) return;
    const copy = { ...source, id: newLayerId(source.type === "text" ? "t" : "i", value.elements) } as CertificateElement;
    Object.assign(copy, clampBox({ ...copy, x: copy.x + 2, y: copy.y + 2 }));
    setElements([...value.elements.slice(0, index + 1), copy, ...value.elements.slice(index + 1)]);
    setSelectedId(copy.id);
  }

  function deleteLayer(id: string) {
    if (!value) return;
    const index = value.elements.findIndex((element) => element.id === id);
    const elements = value.elements.filter((element) => element.id !== id);
    setElements(elements);
    if (selectedId === id) setSelectedId(elements[Math.min(index, elements.length - 1)]?.id ?? null);
  }

  function handleKeyDown(event: KeyboardEvent<Element>) {
    if (!selected || busyOrDisabled || isTyping(event.target)) return;
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      deleteLayer(selected.id);
      return;
    }
    const step = event.shiftKey ? 5 : 0.5;
    const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
    if (!delta) return;
    event.preventDefault();
    changeElement(selected.id, { x: selected.x + delta[0]!, y: selected.y + delta[1]! });
  }

  async function generatePreview() {
    if (!value) return;
    await run(async () => {
      const result = await previewCertificate({ organisationSlug: props.organisationSlug, eventId: props.eventId, template: value, name, contributor: props.contributor === true });
      if (result.ok) setPreview(result.data!.image); else setError(result.error);
    }, "Preview failed. Please try again.");
  }

  return (
    <div className="flex flex-col gap-4 rounded-xl border border-line bg-subtle p-4 md:p-6">
      <div>
        <h3 className="text-title text-ink">Certificate designer</h3>
        <p className="mt-1 text-body-ui text-ink-secondary">Upload your certificate artwork, then add text and images on top. Text can include values such as the attendee’s name, which are filled in for each certificate and reduced automatically to fit their box.</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <label className={cn(buttonClasses({ variant: "secondary" }), busyOrDisabled ? "pointer-events-none border-line bg-surface text-ink-muted" : "cursor-pointer")} aria-disabled={busyOrDisabled || undefined}>
          <Upload aria-hidden className="size-[18px]" />
          {busy ? "Working…" : value ? "Replace background" : "Upload background"}
          <input hidden type="file" accept="image/jpeg,image/png,image/webp" disabled={busyOrDisabled} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void uploadBackground(file); }} />
        </label>
        {value && <Button variant="quiet" disabled={busyOrDisabled} onClick={() => { setSelectedId(null); update(null); }}>Use default certificate</Button>}
      </div>
      <p className="text-caption text-ink-muted">JPEG, PNG or WebP · up to 5 MB · landscape or portrait. For sharp printing, upload original artwork at least 3508 pixels on its longest side, preferably PNG. Blank backgrounds are shareable images; do not include attendee data.</p>
      {error && <Callout tone="danger" role="alert">{error}</Callout>}
      {!value ? <Callout tone="info">The standard Space Works Events certificate will be used until you upload a background.</Callout> : <>
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start">
          <div className="flex min-w-0 flex-col gap-3">
            <div role="toolbar" aria-label="Add layers" className="flex flex-wrap items-center gap-2">
              <Button variant="secondary" size="sm" startIcon={<Type />} disabled={busyOrDisabled || atLimit} onClick={addText}>Add text</Button>
              <label className={cn(buttonClasses({ variant: "secondary", size: "sm" }), busyOrDisabled || atLimit ? "pointer-events-none border-line bg-surface text-ink-muted" : "cursor-pointer")} aria-disabled={busyOrDisabled || atLimit || undefined}>
                <ImagePlus aria-hidden className="size-4" />
                Add image
                <input hidden type="file" accept="image/png,image/jpeg,image/webp" disabled={busyOrDisabled || atLimit} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void addImage(file); }} />
              </label>
              {atLimit && <span className="text-caption text-ink-muted">Up to {MAX_LAYERS} layers.</span>}
            </div>
            <CertificateCanvas
              backgroundKey={value.backgroundKey}
              elements={value.elements}
              size={dimensions}
              selectedId={selectedId}
              values={values}
              disabled={busyOrDisabled}
              onSelect={setSelectedId}
              onChangeElement={changeElement}
              onKeyDown={handleKeyDown}
              onBackgroundLoad={setDimensions}
              onBackgroundError={() => setError("Background could not load. Try uploading it again.")}
            />
            <p className="text-caption text-ink-muted">Click a layer to select it, drag to move it, and drag the corner handle to resize. Arrow keys nudge the selected layer (hold Shift for bigger steps). Logos, signatures and seals keep their shape; PNG transparency is kept.</p>
            {!usesNameTag(value) && (
              <Callout tone="warning" title="No attendee name">No text layer includes the attendee’s name. Add a text layer and insert “Attendee name” so each certificate is personalised.</Callout>
            )}
          </div>
          <fieldset disabled={busyOrDisabled} className="m-0 flex min-w-0 flex-col gap-4 border-0 p-0">
            <legend className="sr-only">Layers and layer settings</legend>
            <LayersPanel
              elements={value.elements}
              selectedId={selectedId}
              disabled={busyOrDisabled}
              onSelect={setSelectedId}
              onMove={moveLayer}
              onDuplicate={duplicateLayer}
              onDelete={deleteLayer}
              onKeyDown={handleKeyDown}
            />
            {selected
              ? <LayerInspector key={selected.id} element={selected} disabled={busyOrDisabled} onChange={(patch) => changeElement(selected.id, patch)} onReplaceImage={(file) => void replaceImage(selected.id, file)} />
              : value.elements.length > 0 && <p className="text-caption text-ink-muted">Select a layer to edit it.</p>}
          </fieldset>
        </div>

        <section aria-labelledby="certificate-samples-title" className="flex flex-col gap-3 rounded-lg border border-line bg-panel p-3.5">
          <h4 id="certificate-samples-title" className="text-label text-ink">Sample values</h4>
          <Field label="Preview attendee name" helperText="For preview only. Downloads use the attendee’s registered name.">
            <Input value={name} maxLength={200} disabled={busyOrDisabled} onChange={(e) => { setName(e.target.value); setPreview(null); }} />
          </Field>
          <dl className="grid gap-x-4 gap-y-1.5 text-caption sm:grid-cols-2">
            {(Object.keys(certificateMergeTags) as CertificateMergeTag[]).filter((tag) => tag !== "name" && (props.contributor || !CONTRIBUTOR_MERGE_TAGS.includes(tag))).map((tag) => (
              <div key={tag} className="flex min-w-0 gap-1.5">
                <dt className="shrink-0 text-ink-muted">{certificateMergeTags[tag].label}:</dt>
                <dd className="min-w-0 truncate text-ink">{values[tag]}</dd>
              </div>
            ))}
          </dl>
        </section>

        <p className="text-caption text-ink-muted">Layout preview uses your browser’s fonts. Generate a preview to check the exact font and fit used in the downloaded JPEG.</p>
        <Button variant="secondary" className="self-start" disabled={busyOrDisabled || !name.trim()} onClick={() => void generatePreview()}>Generate exact preview</Button>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {preview && <img src={preview} alt="Generated certificate preview with the sample attendee name" className="w-full rounded-lg" />}
        <Callout tone="info">{props.contributor ? "Save to apply this design to contributor certificates you issue from now on." : "Save feedback settings below to apply this design. It is used automatically after an eligible attendee completes feedback."}</Callout>
      </>}
    </div>
  );
}
