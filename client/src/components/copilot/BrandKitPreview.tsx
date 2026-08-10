/**
 * BrandKitPreview — read-only preview of a branding proposal payload: the
 * generated logo (logoSvgDataUri rendered in an <img>), color swatches with
 * hex values, and the tagline. Defensive: no logo → placeholder tile, no
 * colors → muted note.
 */
import React from "react";
import { ImageOff } from "lucide-react";
import { normalizeBrandKit } from "@/lib/copilotLogic";

export function BrandKitPreview({ payload }: { payload: unknown }) {
  const kit = normalizeBrandKit(payload);
  return (
    <div className="space-y-3 text-sm">
      <div className="flex items-start gap-3">
        {kit.logoSvgDataUri ? (
          <img
            src={kit.logoSvgDataUri}
            alt={`${kit.brandName} logo`}
            className="h-16 w-16 shrink-0 rounded-md border bg-white/5 object-contain"
          />
        ) : (
          <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-md border bg-muted/30">
            <ImageOff className="h-5 w-5 text-muted-foreground" />
          </div>
        )}
        <div className="min-w-0">
          <p className="font-medium truncate">{kit.brandName}</p>
          {kit.tagline ? (
            <p className="text-xs text-muted-foreground italic mt-0.5">“{kit.tagline}”</p>
          ) : (
            <p className="text-xs text-muted-foreground italic mt-0.5">No tagline proposed.</p>
          )}
        </div>
      </div>
      <div>
        <p className="text-xs font-medium text-muted-foreground mb-1">Palette</p>
        {kit.colors.length === 0 ? (
          <p className="text-xs text-muted-foreground italic">No colors proposed yet.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {kit.colors.map((c) => (
              <div key={`${c.name}-${c.hex}`} className="flex items-center gap-1.5 rounded-md border px-2 py-1">
                <span className="h-4 w-4 rounded-sm border" style={{ backgroundColor: c.hex }} />
                <span className="text-xs">{c.name}</span>
                <span className="text-xs font-mono text-muted-foreground">{c.hex}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
