import type { StoreConfig } from "@shared/storefront/config";

const SERIF = new Set(["Cormorant Garamond", "Playfair Display", "Fraunces", "DM Serif Display", "Instrument Serif", "Bodoni Moda", "Lora"]);
const stack = (font: string) => `"${font}", ${font === "JetBrains Mono" ? "ui-monospace, monospace" : SERIF.has(font) ? "Georgia, serif" : "system-ui, sans-serif"}`;

/** Every template's look arrives as CSS variables on one element, so nothing can leak into another store. */
export function themeStyle(config: StoreConfig): React.CSSProperties {
  const t = config.theme;
  return {
    "--bg": t.background, "--surface": t.surface, "--text": t.text, "--muted": t.muted, "--line": t.line,
    "--accent": t.accent, "--accent-text": t.accentText, "--inverse": t.inverse, "--inverse-text": t.inverseText, "--sale": t.sale,
    "--font-heading": stack(t.headingFont), "--font-body": stack(t.bodyFont),
    "--heading-case": t.headingCase === "upper" ? "uppercase" : "none", "--heading-weight": t.headingWeight, "--heading-tracking": `${t.headingTracking}em`,
    "--radius": `${t.radius}px`, "--width": `${t.width}px`, "--gap": `${t.spacing}px`,
  } as React.CSSProperties;
}
