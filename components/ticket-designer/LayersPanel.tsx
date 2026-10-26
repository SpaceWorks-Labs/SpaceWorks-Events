"use client";

import { ArrowDown, ArrowUp, Eye, EyeOff, Lock, LockOpen } from "lucide-react";
import { IconButton } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import type { DesignElement } from "@/lib/ticketDesign/schema";
import { layerName } from "./geometry";

/**
 * Layers, top first (docs/TICKET_DESIGNER.md): select, move up or down the
 * stack, hide and lock. The QR code can't be hidden.
 */
export function LayersPanel({ elements, selectedId, onSelect, onToggle, onMove }: {
  elements: DesignElement[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onToggle: (id: string, flag: "hidden" | "locked") => void;
  onMove: (id: string, direction: 1 | -1) => void;
}) {
  const top = [...elements].reverse();
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-h4 text-ink">Layers</h3>
      <ul aria-label="Layers" className="flex flex-col gap-1">
        {top.map((element, index) => (
          <li key={element.id} className={cn("flex items-center gap-1 rounded-lg border px-2 py-1", element.id === selectedId ? "border-primary bg-subtle" : "border-line bg-panel")}>
            <button type="button" className={cn("min-h-9 min-w-0 flex-1 truncate text-left text-body-ui", element.hidden ? "text-ink-muted" : "text-ink")} onClick={() => onSelect(element.id)} aria-pressed={element.id === selectedId}>
              {layerName(element)}
            </button>
            <IconButton size="sm" variant="quiet" label={`Move ${layerName(element)} up`} disabled={index === 0} onClick={() => onMove(element.id, 1)}><ArrowUp /></IconButton>
            <IconButton size="sm" variant="quiet" label={`Move ${layerName(element)} down`} disabled={index === top.length - 1} onClick={() => onMove(element.id, -1)}><ArrowDown /></IconButton>
            {element.kind === "qr" ? null : (
              <IconButton size="sm" variant="quiet" label={element.hidden ? `Show ${layerName(element)}` : `Hide ${layerName(element)}`} onClick={() => onToggle(element.id, "hidden")}>{element.hidden ? <EyeOff /> : <Eye />}</IconButton>
            )}
            <IconButton size="sm" variant="quiet" label={element.locked ? `Unlock ${layerName(element)}` : `Lock ${layerName(element)}`} onClick={() => onToggle(element.id, "locked")}>{element.locked ? <Lock /> : <LockOpen />}</IconButton>
          </li>
        ))}
      </ul>
    </div>
  );
}
