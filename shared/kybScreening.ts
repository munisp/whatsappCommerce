/**
 * What KYB screening (registry + sanctions) needs from an application. Screening can't run without all three, and an
 * application can't be approved unless screening runs (fail closed), so these are required to submit as well.
 * Shared by the merchant's Set up shop wizard, the admin KYB review page and the kyc router so they can't disagree.
 */
export const KYB_SCREENING_FIELDS = [
  { key: "businessName", label: "registered business name" },
  { key: "businessRegistrationNumber", label: "registration number" },
  { key: "businessCountry", label: "country" },
] as const;

type ScreeningInput = Partial<Record<(typeof KYB_SCREENING_FIELDS)[number]["key"], string | null | undefined>>;

/** Plain-words labels of the screening fields that are empty, in form order. */
export function missingScreeningFields(app: ScreeningInput): string[] {
  return KYB_SCREENING_FIELDS.filter(({ key }) => !String(app[key] ?? "").trim()).map(({ label }) => label);
}

/** "a, b and c" */
export function listInWords(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** A document is "flagged" when the automated check ran and the verdict isn't clean (authentic and not tampered). */
export function isFlagged(doc: { processedAt?: Date | string | null; isAuthentic?: boolean | null; isTampered?: boolean | null }): boolean {
  return Boolean(doc.processedAt) && (doc.isAuthentic !== true || doc.isTampered !== false);
}
