"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { designProblem, type DesignDocument } from "@/lib/ticketDesign/schema";

/**
 * The editor's document with undo/redo and autosave (docs/TICKET_DESIGNER.md).
 * Edits are functions of the latest document (`apply`), so a slow upload can
 * never overwrite changes made meanwhile. A drag or resize shows a live draft
 * and lands in history once, when it ends. Saving happens about 1.5s after
 * the last change, on leaving the page, and only for documents the server
 * would accept.
 */

const HISTORY = 100;
const AUTOSAVE_MS = 1500;

type State = { past: DesignDocument[]; present: DesignDocument; future: DesignDocument[]; draft: DesignDocument | null; };
type Action =
  | { type: "apply"; fn: (document: DesignDocument) => DesignDocument; }
  | { type: "draft"; document: DesignDocument; }
  | { type: "endDraft"; }
  | { type: "undo"; }
  | { type: "redo"; };

function commit(state: State, document: DesignDocument): State {
  if (document === state.present) return { ...state, draft: null };
  return { past: [...state.past, state.present].slice(-HISTORY), present: document, future: [], draft: null };
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "apply":
      return commit(state, action.fn(state.present));
    case "draft":
      return { ...state, draft: action.document };
    case "endDraft":
      return state.draft ? commit(state, state.draft) : state;
    case "undo": {
      const previous = state.past.at(-1);
      return previous ? { past: state.past.slice(0, -1), present: previous, future: [state.present, ...state.future], draft: null } : state;
    }
    case "redo": {
      const next = state.future[0];
      return next ? { past: [...state.past, state.present], present: next, future: state.future.slice(1), draft: null } : state;
    }
  }
}

export type SaveStatus = { state: "saved" | "saving" | "pending"; } | { state: "invalid" | "error"; message: string; };

export function useDesignState(initial: DesignDocument, save: (document: DesignDocument) => Promise<{ ok: boolean; error?: string; }>) {
  const [state, dispatch] = useReducer(reducer, { past: [], present: initial, future: [], draft: null });
  const [status, setStatus] = useState<SaveStatus>({ state: "saved" });
  const lastSaved = useRef(initial);
  // The same document as lastSaved, as state, for rendering the status.
  const [savedDocument, setSavedDocument] = useState(initial);
  const latest = useRef(initial);
  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
    latest.current = state.present;
  }, [save, state.present]);

  /** Save `document` unless the server already has it (`force` saves anyway, e.g. after a rename). */
  const flush = useCallback(async (document: DesignDocument, force = false) => {
    if (document === lastSaved.current && !force) {
      setStatus({ state: "saved" });
      return true;
    }
    const problem = designProblem(document);
    if (problem) {
      setStatus({ state: "invalid", message: problem });
      return false;
    }
    setStatus({ state: "saving" });
    try {
      const result = await saveRef.current(document);
      if (!result.ok) {
        setStatus({ state: "error", message: result.error ?? "Couldn't save the design." });
        return false;
      }
    } catch {
      setStatus({ state: "error", message: "Couldn't reach the server. Your changes will save when you edit again." });
      return false;
    }
    lastSaved.current = document;
    setSavedDocument(document);
    setStatus({ state: latest.current === document ? "saved" : "pending" });
    return true;
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void flush(state.present), state.present === lastSaved.current ? 0 : AUTOSAVE_MS);
    return () => window.clearTimeout(timer);
  }, [state.present, flush]);

  // Leaving the page saves what's left, and warns while a save is still owed.
  useEffect(() => {
    const unsaved = () => latest.current !== lastSaved.current;
    const onPageHide = () => { if (unsaved()) void flush(latest.current); };
    const onBeforeUnload = (event: BeforeUnloadEvent) => { if (unsaved()) event.preventDefault(); };
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("beforeunload", onBeforeUnload);
      onPageHide();
    };
  }, [flush]);

  return {
    document: state.draft ?? state.present,
    /** Change the latest document (never a stale copy). */
    apply: useCallback((fn: (document: DesignDocument) => DesignDocument) => dispatch({ type: "apply", fn }), []),
    draft: useCallback((document: DesignDocument) => dispatch({ type: "draft", document }), []),
    endDraft: useCallback(() => dispatch({ type: "endDraft" }), []),
    undo: useCallback(() => dispatch({ type: "undo" }), []),
    redo: useCallback(() => dispatch({ type: "redo" }), []),
    canUndo: state.past.length > 0,
    canRedo: state.future.length > 0,
    status: state.present !== savedDocument && status.state === "saved" ? ({ state: "pending" } as const) : status,
    /** Save now (before a preview, or after a rename); true when the server has the current document. */
    saveNow: useCallback((force = false) => flush(latest.current, force), [flush]),
  };
}
