/**
 * WaMenuPreview — read-only preview of a waMenu proposal payload: greeting
 * block, use-case chips (enabled state + order), custom items and the
 * fallback response. Normalizes defensively via normalizeWaMenu, so missing
 * fields degrade to placeholders instead of crashing.
 */
import React from "react";
import { Badge } from "@/components/ui/badge";
import { normalizeWaMenu, type WaMenuView } from "@/lib/copilotLogic";

export function WaMenuPreview({ payload }: { payload: unknown }) {
  const menu: WaMenuView = normalizeWaMenu(payload);
  const ordered = [...menu.useCases].sort((a, b) => a.order - b.order);
  return (
    <div className="space-y-3 text-sm">
      <div>
        <p className="text-xs font-medium text-muted-foreground mb-1">Greeting</p>
        <div className="rounded-md border bg-muted/30 px-3 py-2 whitespace-pre-wrap">{menu.greeting}</div>
      </div>
      <div>
        <p className="text-xs font-medium text-muted-foreground mb-1">Use cases</p>
        {ordered.length === 0 ? (
          <p className="text-xs text-muted-foreground italic">No use cases proposed yet.</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {ordered.map((u) => (
              <Badge
                key={u.id}
                variant="outline"
                className={`font-normal ${u.enabled ? "border-emerald-500/40 text-emerald-400" : "border-border text-muted-foreground line-through"}`}
              >
                {u.order}. {u.label}
              </Badge>
            ))}
          </div>
        )}
      </div>
      {menu.customItems.length > 0 && (
        <div>
          <p className="text-xs font-medium text-muted-foreground mb-1">Custom items</p>
          <ul className="space-y-1">
            {menu.customItems.map((c, i) => (
              <li key={`${c.label}-${i}`} className="rounded-md border px-3 py-1.5">
                <span className="font-medium">{c.label}</span>
                <span className="text-muted-foreground"> — {c.response}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div>
        <p className="text-xs font-medium text-muted-foreground mb-1">Fallback</p>
        <p className="text-xs text-muted-foreground italic">{menu.fallback}</p>
      </div>
    </div>
  );
}
