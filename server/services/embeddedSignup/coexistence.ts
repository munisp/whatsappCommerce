/**
 * W16 number coexistence (roadmap F9).
 *
 * Meta "coexistence" lets a tenant keep using the WhatsApp Business app on
 * the same phone number while the number is also connected to the Cloud API
 * via embedded signup. Not everything works the same in that mode: this
 * module records the coexistence flag + onboarding status on the tenant's
 * credential record (settings.whatsapp) and reports which platform features
 * are degraded so the UI can set expectations.
 *
 * NOTE: sending behavior is intentionally NOT changed this wave — this is
 * reporting/flagging only.
 */

export type OnboardingStatus = "not_started" | "pending" | "completed" | "failed";

export interface WhatsAppCredentialState {
  wabaId: string;
  phoneNumberId: string;
  displayPhoneNumber: string;
  coexistence: boolean;
  onboardingStatus: OnboardingStatus;
}

/** Read the coexistence/onboarding state from tenant settings. */
export function readCredentialState(settings: unknown): WhatsAppCredentialState {
  const wa = (((settings as any)?.whatsapp ?? {}) as Record<string, unknown>);
  const statusRaw = typeof wa.onboardingStatus === "string" ? wa.onboardingStatus : "";
  const onboardingStatus: OnboardingStatus = (
    ["not_started", "pending", "completed", "failed"] as const
  ).includes(statusRaw as OnboardingStatus)
    ? (statusRaw as OnboardingStatus)
    : wa.wabaId
      ? "completed"
      : "not_started";
  return {
    wabaId: typeof wa.wabaId === "string" ? wa.wabaId : "",
    phoneNumberId: typeof wa.phoneNumberId === "string" ? wa.phoneNumberId : "",
    displayPhoneNumber: typeof wa.displayPhoneNumber === "string" ? wa.displayPhoneNumber : "",
    coexistence: wa.coexistence === true,
    onboardingStatus,
  };
}

export type FeatureAvailability = "available" | "limited";

export interface CoexistenceLimitation {
  feature: string;
  availability: FeatureAvailability;
  /** Why the feature is degraded under coexistence (empty when available). */
  reason: string;
}

/**
 * Features that depend on exclusive control of the phone number. Under
 * coexistence the WhatsApp Business app keeps partial control, so these are
 * reported as `limited`. When coexistence is off everything is available.
 */
export function coexistenceLimitations(state: WhatsAppCredentialState): CoexistenceLimitation[] {
  const limited = state.coexistence;
  const mark = (feature: string, reason: string): CoexistenceLimitation =>
    limited
      ? { feature, availability: "limited", reason }
      : { feature, availability: "available", reason: "" };
  return [
    mark(
      "message_history_sync",
      "Messages sent from the WhatsApp Business app are not visible to the Cloud API; conversation history may be incomplete.",
    ),
    mark(
      "automated_replies",
      "The Business app's own auto-replies and away messages still run and can race platform automation on the same number.",
    ),
    mark(
      "broadcast_deliverability",
      "Broadcasts sent from the Business app share the number's quality rating; blocks or spam reports there affect API sends.",
    ),
    mark(
      "template_management",
      "Templates created in the Business app are not managed by the platform; only WABA-level API templates are tracked.",
    ),
    mark(
      "webhook_event_completeness",
      "Some status/typing events stay local to the Business app and never reach webhooks.",
    ),
  ];
}
