/**
 * Rolling tenant dashboard features out in stages. A feature is identified by its dashboard path.
 * This controls what shops SEE: it does not secure the API behind a feature.
 */
export const ROLLOUT_STATES = ["off", "selected", "all"] as const;
export type RolloutState = (typeof ROLLOUT_STATES)[number];

/**
 * A shop can't run without these, so they can't be hidden. Set up shop (/onboarding-wizard) is where a new business
 * is created and where it submits business verification (KYB), which going live requires; hiding it stranded every
 * new merchant the moment their shop existed (the bulk switch-off of 2026-11-03).
 */
export const ALWAYS_ON_FEATURES: readonly string[] = ["/portal", "/portal/setup", "/tenant-settings", "/onboarding-wizard"];

export const NEW_BADGE_DAYS = 14;

/** Off wins for everyone. Selected needs an opt-in. All (or no decision yet) applies unless a shop is opted out. */
export function featureVisible(key: string, state: string | null | undefined, override: boolean | null | undefined): boolean {
  if (ALWAYS_ON_FEATURES.includes(key)) return true;
  if (state === "off") return false;
  if (state === "selected") return override === true;
  return override !== false;
}

/** The feature a page belongs to: the longest feature path that is the location or a parent of it. */
export function featureForPath(location: string, keys: readonly string[]): string | null {
  let best: string | null = null;
  for (const key of keys) {
    if ((location === key || location.startsWith(`${key}/`)) && (!best || key.length > best.length)) best = key;
  }
  return best;
}
