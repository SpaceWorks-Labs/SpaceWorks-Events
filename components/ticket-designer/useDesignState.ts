"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { designProblem, type DesignDocument } from "@/lib/ticketDesign/schema";

/**
 * The editor's document with undo/redo and autosave (docs/TICKET_DESIGNER.md).
 * A drag or resize shows a live draft and lands in history once, when it ends.
 * Saving happens about 1.5s after the last change, and only for documents the
 * server would accept.
 */

const HISTORY = 100;
const AUTOSAVE_MS = 1500;

type State = { past: DesignDocument[]; present: DesignDocument; future: DesignDocument[]; draft: DesignDocument | null; };
type Action =
  | { type: "commit"; document: DesignDocument; }
  | { type: "draft"; document: DesignDocument; }
  | { type: "endDraft"; }
  | { type: "undo"; }
  | { type: "redo"; };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "commit":
      if (action.document === state.present) return { ...state, draft: null };
      return { past: [...state.past, state.present].slice(-HISTORY), present: action.document, future: [], draft: null };
    case "draft":
      return { ...state, draft: action.document };
    case "endDraft":
      return state.draft ? reducer(state, { type: "commit", document: state.draft }) : state;
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
  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  }, [save]);

  const flush = useCallback(async (document: DesignDocument) => {
    if (document === lastSaved.current) return true;
    const problem = designProblem(document);
    if (problem) {
      setStatus({ state: "invalid", message: problem });
      return false;
    }
    setStatus({ state: "saving" });
    const result = await saveRef.current(document);
    if (!result.ok) {
      setStatus({ state: "error", message: result.error ?? "Couldn't save the design." });
      return false;
    }
    lastSaved.current = document;
    setStatus({ state: "saved" });
    return true;
  }, []);

  useEffect(() => {
    if (state.present === lastSaved.current) return;
    let current = true;
    const timer = window.setTimeout(() => {
      if (current) void flush(state.present);
    }, AUTOSAVE_MS);
    setStatus((previous) => (previous.state === "saving" ? previous : { state: "pending" }));
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [state.present, flush]);

  return {
    document: state.draft ?? state.present,
    commit: useCallback((document: DesignDocument) => dispatch({ type: "commit", document }), []),
    draft: useCallback((document: DesignDocument) => dispatch({ type: "draft", document }), []),
    endDraft: useCallback(() => dispatch({ type: "endDraft" }), []),
    undo: useCallback(() => dispatch({ type: "undo" }), []),
    redo: useCallback(() => dispatch({ type: "redo" }), []),
    canUndo: state.past.length > 0,
    canRedo: state.future.length > 0,
    status,
    /** Save now (before a preview); true when the server has the current document. */
    saveNow: useCallback(() => flush(state.present), [flush, state.present]),
  };
}
