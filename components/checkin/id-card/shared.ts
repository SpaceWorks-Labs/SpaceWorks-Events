"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { saveBadgeDesign } from "@/app/actions/badge";
import {
  defaultIdCardPrintSettings,
  normalizeIdCardPrintSettings,
  type IdCardLayoutElement,
  type IdCardPrintSettings,
} from "@/lib/idCardPrint";
import type { IdCardAttendee } from "@/lib/badge/types";

export type { IdCardAttendee } from "@/lib/badge/types";
export { printableFields, withMergeFields } from "@/lib/badge/types";

export type RegistrationField = { key: string; label: string };

export const SAFE_MARGIN_MM = 5;

export const ELEMENT_LABELS: Record<IdCardLayoutElement, string> = {
  header: "Heading",
  name: "Attendee name",
  email: "Email",
  details: "Registration answers",
  qr: "Check-in QR",
  footer: "Footer",
  logo: "Organisation logo",
  eventLogo: "Event logo",
  symbol: "Space Works symbol",
  photo: "Photo",
  sponsors: "Sponsor logos",
  idNumber: "ID number",
  validUntil: "Valid until",
};

export const registrationFieldKey = (key: string) => `registration:${key}`;

/** The saved design as the server sent it with the page. */
export type BadgeDesignSeed = { settings: unknown; saved: boolean; updatedAt: string | null };

export type BadgeDesignSource = {
  eventId: string;
  organisationSlug: string;
  eventTitle: string;
  organisationName: string;
  design: BadgeDesignSeed | null;
  /** Dashboard desks save to the server; a PIN station only reads the saved design. */
  canSave: boolean;
};

/**
 * - saved: the server has this design
 * - pending: changed here, saving shortly
 * - saving: being saved
 * - local: kept on this device only (offline); saves when back online
 * - error: the last save failed
 */
export type BadgeSaveStatus = "saved" | "pending" | "saving" | "local" | "error";

type Entry = {
  settings: IdCardPrintSettings;
  status: BadgeSaveStatus;
  error: string | null;
  serverUpdatedAt: string | null;
  dirty: boolean;
  timer: number | null;
  source: BadgeDesignSource;
};

/** Device copy of the design: an offline fallback and the migration path from browser-only designs. */
const storageKey = (eventId: string) => `swe:checkin:id-card:${eventId}`;
const legacyStorageKey = (eventId: string) => `yuyu:checkin:id-card:${eventId}`;
const SAVE_DELAY_MS = 800;

const entries = new Map<string, Entry>();
const listeners = new Map<string, Set<() => void>>();

function notify(eventId: string) {
  listeners.get(eventId)?.forEach((listener) => listener());
}

function setEntry(eventId: string, patch: Partial<Entry>) {
  const current = entries.get(eventId);
  if (!current) return;
  entries.set(eventId, { ...current, ...patch });
  notify(eventId);
}

function seedSettings(source: BadgeDesignSource) {
  return source.design?.saved
    ? normalizeIdCardPrintSettings(source.design.settings, source.eventTitle, source.organisationName)
    : defaultIdCardPrintSettings(source.eventTitle, source.organisationName);
}

function ensureEntry(source: BadgeDesignSource): Entry {
  let entry = entries.get(source.eventId);
  if (!entry) {
    entry = {
      settings: seedSettings(source),
      status: "saved",
      error: null,
      serverUpdatedAt: source.design?.updatedAt ?? null,
      dirty: false,
      timer: null,
      source,
    };
    // Only the browser keeps entries. On the server this map would outlive the
    // request and every later render would show the first design it saw.
    if (typeof window !== "undefined") entries.set(source.eventId, entry);
  }
  return entry;
}

function writeDeviceCopy(eventId: string, settings: IdCardPrintSettings) {
  try {
    window.localStorage.setItem(storageKey(eventId), JSON.stringify(settings));
  } catch {
    // Private or locked-down browsers keep the design in memory only.
  }
}

function readDeviceCopy(eventId: string): unknown {
  try {
    const saved = window.localStorage.getItem(storageKey(eventId)) ?? window.localStorage.getItem(legacyStorageKey(eventId));
    return saved ? JSON.parse(saved) : null;
  } catch {
    return null;
  }
}

async function saveNow(eventId: string) {
  const entry = entries.get(eventId);
  if (!entry || !entry.source.canSave || entry.status === "saving") return;
  if (typeof navigator !== "undefined" && !navigator.onLine) {
    setEntry(eventId, { status: "local", error: null });
    return;
  }
  const settings = entry.settings;
  setEntry(eventId, { status: "saving", dirty: false, timer: null });
  let result: Awaited<ReturnType<typeof saveBadgeDesign>>;
  try {
    result = await saveBadgeDesign({ organisationSlug: entry.source.organisationSlug, eventId, settings });
  } catch {
    result = { ok: false, error: "The design couldn't be saved. Check your connection." };
  }
  const latest = entries.get(eventId);
  if (!latest) return;
  if (!result.ok) {
    setEntry(eventId, { status: "error", error: result.error, dirty: true });
    return;
  }
  setEntry(eventId, { serverUpdatedAt: result.data?.updatedAt ?? latest.serverUpdatedAt, status: latest.dirty ? "pending" : "saved", error: null });
  if (latest.dirty) scheduleSave(eventId);
}

function scheduleSave(eventId: string) {
  const entry = entries.get(eventId);
  if (!entry || !entry.source.canSave) return;
  if (entry.timer) window.clearTimeout(entry.timer);
  if (entry.status === "saving") {
    setEntry(eventId, { dirty: true });
    return;
  }
  const timer = window.setTimeout(() => void saveNow(eventId), SAVE_DELAY_MS);
  setEntry(eventId, { status: "pending", dirty: true, timer });
}

function writeSettings(eventId: string, settings: IdCardPrintSettings) {
  setEntry(eventId, { settings });
  writeDeviceCopy(eventId, settings);
  scheduleSave(eventId);
}

/**
 * The event's badge design, shared by every open designer, preview and print
 * sheet on the page. It starts from the server's saved design, autosaves
 * changes (debounced) and keeps a device copy for offline use. A design that
 * only ever lived in this browser is uploaded once when the server has none.
 * `update` records undo history unless told not to (e.g. mid-drag moves).
 */
export function useIdCardSettings(source: BadgeDesignSource) {
  const { eventId } = source;
  const entry = ensureEntry(source);
  // Keep the latest props (e.g. canSave, slug) for saves started later.
  entry.source = source;

  const subscribe = useCallback((onChange: () => void) => {
    let set = listeners.get(eventId);
    if (!set) {
      set = new Set();
      listeners.set(eventId, set);
    }
    set.add(onChange);
    return () => {
      set.delete(onChange);
    };
  }, [eventId]);
  const getSnapshot = useCallback(() => entries.get(eventId) ?? entry, [entry, eventId]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const settings = snapshot.settings;

  // One-time migration from a browser-only design, and the offline copy.
  const designSaved = Boolean(source.design?.saved);
  const canSave = source.canSave;
  useEffect(() => {
    if (designSaved) return;
    const local = readDeviceCopy(eventId);
    const current = entries.get(eventId);
    if (!local || !current || current.dirty || current.serverUpdatedAt) return;
    const migrated = normalizeIdCardPrintSettings(local, source.eventTitle, source.organisationName);
    setEntry(eventId, { settings: migrated });
    if (canSave) scheduleSave(eventId);
    // Only on first mount for this event.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId]);

  // Another desk saved a newer design: adopt it unless this desk has unsaved changes.
  const incoming = source.design?.updatedAt ?? null;
  useEffect(() => {
    const current = entries.get(eventId);
    if (!current || !incoming || !source.design?.saved) return;
    if (current.dirty || current.status !== "saved") return;
    if (current.serverUpdatedAt && current.serverUpdatedAt >= incoming) return;
    setEntry(eventId, { settings: seedSettings(source), serverUpdatedAt: incoming });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId, incoming]);

  // Save the offline copy once the connection comes back.
  useEffect(() => {
    if (!canSave) return;
    const onOnline = () => {
      const current = entries.get(eventId);
      if (current && (current.status === "local" || current.status === "error")) void saveNow(eventId);
    };
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [canSave, eventId]);

  const [undoStack, setUndoStack] = useState<IdCardPrintSettings[]>([]);
  const [redoStack, setRedoStack] = useState<IdCardPrintSettings[]>([]);
  // Handlers read the newest settings even mid-drag, between renders.
  const latest = useRef(settings);
  useLayoutEffect(() => {
    latest.current = settings;
  }, [settings]);

  const checkpoint = useCallback(() => {
    setUndoStack((stack) => [...stack.slice(-49), latest.current]);
    setRedoStack([]);
  }, []);

  const update = useCallback((patch: Partial<IdCardPrintSettings>, record = true) => {
    if (!entries.get(eventId)?.source.canSave) return;
    const current = latest.current;
    if (record) checkpoint();
    const next = normalizeIdCardPrintSettings({ ...current, ...patch }, source.eventTitle, source.organisationName);
    // Text is kept exactly as typed (including empty) while editing.
    for (const [key, maxLength] of [["heading", 120], ["badgeLabel", 40], ["footerText", 80]] as const) {
      next[key] = (patch[key] ?? current[key]).slice(0, maxLength);
    }
    latest.current = next;
    writeSettings(eventId, next);
  }, [checkpoint, eventId, source.eventTitle, source.organisationName]);

  const undo = useCallback(() => {
    const previous = undoStack[undoStack.length - 1];
    if (!previous) return;
    setUndoStack((stack) => stack.slice(0, -1));
    setRedoStack((stack) => [...stack, latest.current]);
    writeSettings(eventId, previous);
  }, [eventId, undoStack]);

  const redo = useCallback(() => {
    const next = redoStack[redoStack.length - 1];
    if (!next) return;
    setRedoStack((stack) => stack.slice(0, -1));
    setUndoStack((stack) => [...stack, latest.current]);
    writeSettings(eventId, next);
  }, [eventId, redoStack]);

  const retry = useCallback(() => void saveNow(eventId), [eventId]);

  return {
    settings,
    update,
    checkpoint,
    undo,
    redo,
    retry,
    canUndo: undoStack.length > 0,
    canRedo: redoStack.length > 0,
    status: snapshot.status,
    error: snapshot.error,
    canSave: source.canSave,
  };
}

export const SAVE_STATUS_LABELS: Record<BadgeSaveStatus, string> = {
  saved: "Saved",
  pending: "Unsaved changes",
  saving: "Saving…",
  local: "Saved on this device only",
  error: "Not saved",
};

/** Sample people for the designer: a typical name and a long one to test fitting. */
export function sampleAttendee(fields: RegistrationField[], long = false, teamEvent = false): IdCardAttendee {
  return {
    teamName: teamEvent ? (long ? "The Midnight Debugging Collective" : "Night Owls") : null,
    displayName: long ? "Alexandra Montgomery-Fitzgerald" : "Priya Raman",
    email: long ? "alexandra.montgomery-fitzgerald@example.com" : "priya@example.com",
    checkInQrToken: "preview-check-in-token",
    checkInDetails: [],
    registrationDetails: fields.map((field) => ({
      key: field.key,
      label: field.label,
      value: sampleAnswer(field.label, long),
    })),
    photoUrl: null,
  };
}

function sampleAnswer(label: string, long: boolean) {
  if (/organi[sz]ation|company|employer|school|university/i.test(label)) return long ? "International Federation of Community Builders" : "Tech4Good";
  if (/role|title|position|job/i.test(label)) return long ? "Senior Community Partnerships Lead" : "Designer";
  if (/diet|food|meal/i.test(label)) return "Vegetarian";
  if (/size|shirt/i.test(label)) return "M";
  if (/pronoun/i.test(label)) return "she/her";
  return long ? "A longer sample answer" : "Sample answer";
}
