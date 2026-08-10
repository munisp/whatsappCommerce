/**
 * Maps a registry provider id onto the payment_intents.provider pgEnum
 * (["mojaloop","stripe","paystack","flutterwave","manual"]). Ids outside the
 * enum (custom, monnify, …) bucket as "manual"; the exact serving provider is
 * always available in intent metadata.servedProvider (no migration).
 */
export const INTENT_PROVIDER_ENUM = ["mojaloop", "stripe", "paystack", "flutterwave", "manual"] as const;
export type IntentProvider = (typeof INTENT_PROVIDER_ENUM)[number];

export function toIntentProviderEnum(providerId: string): IntentProvider {
  return (INTENT_PROVIDER_ENUM as readonly string[]).includes(providerId)
    ? (providerId as IntentProvider)
    : "manual";
}
