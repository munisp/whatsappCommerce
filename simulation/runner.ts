/**
 * simulation/runner.ts — executes every journey and prints the result matrix.
 *
 * Usage:  npm run simulate        (tsx simulation/runner.ts)
 *         tsx simulation/runner.ts J03 J17   (subset)
 *
 * Exit code 0 when every journey passes. The vitest wrapper
 * (simulation/simulation.test.ts) calls runAll() so CI runs the same suite.
 */
import { bootWorld, type World } from "./world";
import { recorder } from "./transcript";

export interface Journey {
  id: string;
  name: string;
  feature: string;
  run: (world: World) => Promise<void>;
}

export interface JourneyResult {
  id: string;
  name: string;
  feature: string;
  pass: boolean;
  durationMs: number;
  error?: string;
}

export async function loadJourneys(): Promise<Journey[]> {
  const mods = await Promise.all([
    import("./journeys/j01-consent"),
    import("./journeys/j02-menu"),
    import("./journeys/j03-nlp-order"),
    import("./journeys/j04-menu-shop"),
    import("./journeys/j05-delivery-location"),
    import("./journeys/j06-promo"),
    import("./journeys/j07-payment-confirm"),
    import("./journeys/j08-receipt-screenshot"),
    import("./journeys/j09-order-action-card"),
    import("./journeys/j10-shipment-pin-reaction"),
    import("./journeys/j11-tracking-token"),
    import("./journeys/j12-smart-reorder"),
    import("./journeys/j13-abandoned-cart"),
    import("./journeys/j14-faq"),
    import("./journeys/j15-voice-note"),
    import("./journeys/j16-multilingual"),
    import("./journeys/j17-visual-search"),
    import("./journeys/j18-stock-guard"),
    import("./journeys/j19-restock-notify"),
    import("./journeys/j20-broadcast"),
    import("./journeys/j21-templates"),
    import("./journeys/j22-ctwa"),
    import("./journeys/j23-window-expiry"),
    import("./journeys/j24-delivery-status-pipeline"),
    import("./journeys/j25-read-receipts"),
    import("./journeys/j26-webhook-dedupe"),
    import("./journeys/j27-dispute"),
    import("./journeys/j28-ussd"),
    import("./journeys/j29-meta-catalog"),
    import("./journeys/j30-contact-provisioning"),
    import("./journeys/j31-procurement-menu"),
    import("./journeys/j32-po-submit"),
    import("./journeys/j33-approve-credit-draw"),
    import("./journeys/j34-overdraw-refusal"),
    import("./journeys/j35-paynow-po"),
    import("./journeys/j36-partial-repayment"),
    import("./journeys/j37-dunning"),
    import("./journeys/j38-default-freeze"),
    import("./journeys/j39-whatsapp-full-onboarding"),
    import("./journeys/j40-edit-path"),
    import("./journeys/j41-checkpoint-enforcement"),
    import("./journeys/j42-validation-repair"),
    import("./journeys/j43-idempotency-resume-restart"),
    import("./journeys/j44-admin-channel"),
    import("./journeys/j45-secrets-roundtrip"),
    import("./journeys/j46-observability-capture"),
    import("./journeys/j47-multi-provider-tenants"),
    import("./journeys/j48-manual-bank-transfer"),
    import("./journeys/j49-custom-gateway"),
    import("./journeys/j50-provider-fallback"),
    import("./journeys/j51-flw-credit-repayment"),
    import("./journeys/j52-unified-webhook-isolation"),
    import("./journeys/j53-keycloak-forgery"),
    import("./journeys/j54-invite-mint"),
    import("./journeys/j55-idor-sweep"),
    import("./journeys/j56-marketplace-abuse"),
    import("./journeys/j57-kyb-golive"),
    import("./journeys/j58-kyb-credit"),
    import("./journeys/j59-supplier-verification"),
    import("./journeys/j60-sessions-memberships"),
    import("./journeys/j61-mandate-gated-approval"),
    import("./journeys/j62-charge-first-repayment"),
    import("./journeys/j63-mandate-charge-fallback"),
    import("./journeys/j64-downward-limit-revision"),
    import("./journeys/j65-tenure-suspension"),
    import("./journeys/j66-supplier-direct-settlement"),
    import("./journeys/j67-bureau-consent-gating"),
    import("./journeys/j68-bureau-event-lifecycle"),
    import("./journeys/j69-bureau-retry-dispute"),
    import("./journeys/j70-loan-book-tape"),
    import("./journeys/j71-facility-utilization-covenants"),
    import("./journeys/j72-credit-hardening-e2e"),
    import("./journeys/j73-multilingual-onboarding-e2e"),
    import("./journeys/j74-language-detection-edge-cases"),
    import("./journeys/j75-photo-catalog-bootstrap"),
    import("./journeys/j76-erp-provisioning-e2e"),
    import("./journeys/j77-copilot-config-intents"),
    import("./journeys/j78-w141-credit-regression"),
    import("./journeys/j79-shopify-oauth-catalog-sync"),
    import("./journeys/j80-shopify-order-bridge"),
    import("./journeys/j81-embedded-signup-e2e"),
    import("./journeys/j82-template-library-lifecycle"),
    import("./journeys/j83-marketplace-lifecycle"),
    import("./journeys/j84-new-tenant-distribution-e2e"),
    import("./journeys/j85-whatsapp-visual-stocktake"),
    import("./journeys/j86-broadcast-journey-lifecycle"),
    import("./journeys/j87-journey-frequency-cap-withdrawal"),
    import("./journeys/j88-cod-chat-order"),
    import("./journeys/j89-cod-delivery-failed"),
    import("./journeys/j90-cod-partial-cash"),
    import("./journeys/j91-crm-winback"),
    import("./journeys/j92-credit-score-credit-history"),
    import("./journeys/j93-manufacturer-credit-program"),
    import("./journeys/j94-soc2-compliance"),
    import("./journeys/j95-ml-lead-scoring"),
    import("./journeys/j96-audit-anomaly"),
    import("./journeys/j97-pd-credit-model"),
    import("./journeys/j98-uplift-broadcast"),
    import("./journeys/j99-graph-collusion"),
    import("./journeys/j100-bandit-limits"),
    import("./journeys/j101-llm-copilot"),
    import("./journeys/j102-merchant-onboarding"),
    import("./journeys/j103-whatsapp-paystack-order"),
    import("./journeys/j121-orchestrated-fullstack"),
    import("./journeys/j105-cod-reconciliation"),
    import("./journeys/j106-visual-stocktake-variance"),
    import("./journeys/j107-trade-credit-application"),
    import("./journeys/j108-manufacturer-program-caps"),
    import("./journeys/j109-credit-dunning-cure"),
    import("./journeys/j110-merchant-uplift-broadcast"),
    import("./journeys/j111-journey-automation-winback"),
    import("./journeys/j112-ml-lead-scoring-winback"),
    import("./journeys/j113-collusion-ring-credit-flag"),
    import("./journeys/j114-bandit-rewards-replay"),
    import("./journeys/j104-catalog-to-delivery"),
    import("./journeys/j115-credit-repay-mandate-retry"),
    import("./journeys/j116-support-escalation"),
    import("./journeys/j117-compliance-incident-response"),
    import("./journeys/j118-retention-hold-export"),
    import("./journeys/j119-payment-failover-reconcile"),
    import("./journeys/j120-offline-sync-stock-conflict"),
    import("./journeys/j122-discover-pin-category"),
    import("./journeys/j123-discover-freetext-order"),
    import("./journeys/j124-merchant-geo-onboarding"),
    import("./journeys/j125-sponsored-placement"),
    import("./journeys/j126-escrow-release"),
    // === W27 catalog-ai ===
    import("./journeys/j127-merchant-voice-listing"),
    import("./journeys/j128-merchant-photo-listing"),
    import("./journeys/j129-catalog-draft-edit-reject"),
    import("./journeys/j130-price-suggestion"),
    // === W27 bookkeeping ===
    import("./journeys/j131-sales-digest"),
    import("./journeys/j132-expense-receipt-photo"),
    import("./journeys/j133-tax-export"),
    import("./journeys/j134-week-over-week"),
    // === W27 storefront-i18n ===
    import("./journeys/j135-storefront-render-slug"),
    import("./journeys/j136-language-switch-hausa"),
    import("./journeys/j137-i18n-fallback"),
    // === W27 credit ===
    import("./journeys/j138-credit-score-determinism"),
    import("./journeys/j139-loan-offer-accept-disburse"),
    import("./journeys/j140-loan-auto-repayment"),
    import("./journeys/j141-loan-default"),
    // === W27 delivery-loyalty-reviews (Coder E) ===
    import("./journeys/j142-delivery-aggregation-escrow"),
    import("./journeys/j143-loyalty-earn-redeem"),
    import("./journeys/j144-verified-reviews"),
    import("./journeys/j145-review-trustscore"),
    // === END W27 ===
    // === W27 Coder F: B2B wholesale marketplace + group buying ===
    import("./journeys/j146-wholesale-tiered-order"),
    import("./journeys/j147-wholesale-trade-credit-score-gate"),
    import("./journeys/j148-group-deal-threshold-success"),
    import("./journeys/j149-group-deal-expiry-refunds"),
    // === END W27 Coder F ===
    // === W27 savings-insurance-vouchers (Coder G) ===
    import("./journeys/j150-stokvel-full-cycle"),
    import("./journeys/j151-stokvel-missed-contribution"),
    import("./journeys/j152-insurance-addon-claim"),
    import("./journeys/j153-voucher-rails"),
    // === W28 odoo-sync (Coder A) ===
    import("./journeys/j154-odoo-connect-config"),
    import("./journeys/j155-odoo-paid-order-invoice"),
    import("./journeys/j156-odoo-expense-vendor-bill"),
    import("./journeys/j157-odoo-failure-retry-reconcile"),
    // === END W28 odoo-sync ===
    // === W28 medusa-storefront (Coder B) ===
    import("./journeys/j158-medusa-mapping-backfill"),
    import("./journeys/j159-medusa-webhook-idempotency"),
    import("./journeys/j160-medusa-storefront-toggle"),
    import("./journeys/j161-medusa-order-bridge"),
    // === END W28 medusa-storefront ===
    // === W30 loans-credit (Coder A) ===
    import("./journeys/j162-loan-concurrent-accept"),
    import("./journeys/j163-loan-repayment-race"),
    import("./journeys/j164-loan-funding-leg"),
    import("./journeys/j165-mandate-double-submit"),
    // === END W30 loans-credit ===
    // === W30 escrow-lifecycle (Coder B) ===
    import("./journeys/j166-sla-order-status-guard"),
    import("./journeys/j167-cancel-paid-order-refund"),
    import("./journeys/j168-dispute-refund-executed"),
    import("./journeys/j169-delivery-window-cron-settle"),
    // === END W30 escrow-lifecycle ===
    // === W30 feature-ring (Coder C) ===
    import("./journeys/j170-stokvel-verified-money"),
    import("./journeys/j171-insurance-groupbuy-honesty"),
    import("./journeys/j172-loyalty-voucher-locks"),
    import("./journeys/j173-commissions-invoice-sponsored"),
    // === END W30 feature-ring ===
    // === W30 auth-gates (Coder D) ===
    import("./journeys/j174-kyb-money-gates"),
    import("./journeys/j175-stepup-and-roles"),
    import("./journeys/j176-session-and-invite-guards"),
    import("./journeys/j177-screening-guards"),
    // === END W30 auth-gates ===
    // === W30 deploy-observability (Coder E) ===
    import("./journeys/j178-scheduler-compose-boot"),
    import("./journeys/j179-kyc-hermes-honesty"),
    import("./journeys/j180-dashboard-honesty"),
    import("./journeys/j181-recon-checklist"),
    // === END W30 deploy-observability ===
    // === W30 hotfix-money ===
    import("./journeys/j182-unverified-courier-escrow"),
    // === END W30 hotfix-money ===
    // === W31 vendor-bills ===
    import("./journeys/j183-vendor-bill-pay-full"),
    import("./journeys/j184-vendor-bill-partial"),
    import("./journeys/j185-vendor-bill-whatsapp-capture"),
    import("./journeys/j186-vendor-bill-insufficient-overdue"),
    // === END W31 vendor-bills ===
    // === W31 scheduled-batch ===
    import("./journeys/j187-scheduled-payment-executes"),
    import("./journeys/j188-scheduled-insufficient-retry"),
    import("./journeys/j189-batch-payments"),
    import("./journeys/j190-t1-reminder-dedupe"),
    // === END W31 scheduled-batch ===
    // === W31 approvals (Coder C) ===
    import("./journeys/j191-approval-withdrawal-executes"),
    import("./journeys/j192-approval-reject-expiry"),
    // === END W31 approvals ===
    // === W31 ar-invoices ===
    import("./journeys/j193-ar-invoice-full-payment"),
    import("./journeys/j194-ar-invoice-partial-payments"),
    import("./journeys/j195-ar-invoice-overdue-reminders"),
    import("./journeys/j196-ar-invoice-cancel-link-invalidated"),
    // === W31 merger seam ===
    import("./journeys/j197-approval-vendorbill-scheduled"),
    // === END W31 ar-invoices ===
    // === W32 pay-over-time ===
    import("./journeys/j198-pay-over-time-full-cycle"),
    import("./journeys/j199-pay-over-time-rejections-settle"),
    // === END W32 pay-over-time ===
    // === W32 recurring-tiers ===
    import("./journeys/j200-recurring-autopay"),
    import("./journeys/j201-recurring-approval"),
    import("./journeys/j202-speed-tiers"),
    // === END W32 recurring-tiers ===
    // === W32 earlypay-fx (Coder C) ===
    import("./journeys/j203-earlypay-discount"),
    import("./journeys/j204-fx-quote-accept-execute"),
    import("./journeys/j205-fx-no-corridor"),
    // === END W32 earlypay-fx ===
    // === W33 tax-statements ===
    import("./journeys/j206-tax-profile-annual-totals"),
    import("./journeys/j207-tax-statement-pdf"),
    import("./journeys/j208-tax-statement-send"),
    // === END W33 tax-statements ===
    // === W33 ai-qa-forecast (Coder B) ===
    import("./journeys/j209-finance-qa-intents"),
    import("./journeys/j210-forecast-conservation"),
    import("./journeys/j211-forecast-snapshot-idempotent"),
    // === END W33 ai-qa-forecast ===
    // === W33 embedded-api ===
    import("./journeys/j212-embedded-api-full-flow"),
    import("./journeys/j213-embedded-api-scope-enforcement"),
    import("./journeys/j214-embedded-api-tenant-isolation"),
    // === END W33 embedded-api ===
    // === W34 otel-core (Coder A) ===
    import("./journeys/j215-otel-trace-baggage-metrics"),
    import("./journeys/j216-otel-propagation-chain"),
    import("./journeys/j217-otel-fail-open"),
    // === END W34 otel-core ===
    // === W34 otel-stack (Coder B) ===
    import("./journeys/j218-otel-stack-config"),
    import("./journeys/j219-wa-bridge"),
    // === END W34 otel-stack ===
    // === W34 otel-sidecars (Coder C) ===
    import("./journeys/j220-sidecar-traceparent"),
    import("./journeys/j221-tenant-cardinality-guard"),
    // === END W34 otel-sidecars ===
    // === W34 wa-ops-alert (merger seam) ===
    import("./journeys/j222-wa-ops-alert"),
    // === END W34 wa-ops-alert ===
    // === W35 node-python-otel (Coder C) ===
    import("./journeys/j223-kafka-traceparent"),
    import("./journeys/j224-temporal-otel-interceptors"),
    import("./journeys/j225-mojaloop-spans"),
    import("./journeys/j226-ml-stack-otel"),
    // === END W35 node-python-otel ===
    // === W35 infra-receivers (Coder D) ===
    import("./journeys/j227-collector-infra-receivers"),
    import("./journeys/j228-alert-rules-dashboards"),
    import("./journeys/j229-mig0116-component-status"),
    import("./journeys/j230-otel-stack-probes"),
    // === W37 telegram (Coder A): outbound sender + facade ===
    import("./journeys/j231-telegram-sender-payloads"),
    import("./journeys/j232-telegram-retry-dlq"),
    import("./journeys/j233-channel-sender-facade"),
    import("./journeys/j234-telegram-token-crypto"),
    // === END W37 telegram (Coder A) ===
    // === W37 telegram (Coder B): inbound webhook + identity + consent ===
    import("./journeys/j235-telegram-webhook-security"),
    import("./journeys/j236-telegram-callback-query"),
    import("./journeys/j237-telegram-contact-binding"),
    import("./journeys/j238-telegram-consent"),
    import("./journeys/j239-telegram-session-key"),
    // === END W37 telegram (Coder B) ===
    // === W37 telegram (Coder C — caller parity; J231-J239 owned by Coders A/B, merged separately) ===
    import("./journeys/j240-order-confirmation-parity"),
    import("./journeys/j241-delivery-pin-telegram"),
    import("./journeys/j242-payment-link-url-button"),
    import("./journeys/j243-broadcast-telegram-throttle"),
    import("./journeys/j244-cart-nudge-no-window"),
    import("./journeys/j245-escalation-parity"),
    import("./journeys/j246-parity-matrix-snapshot"),
    // === W38 stock integrity (Coder C) ===
    import("./journeys/j259-paid-cancel-restock-cancel-path"),
    import("./journeys/j260-paid-cancel-restock-updatestatus-path"),
    import("./journeys/j261-reservation-ttl-extension"),
    import("./journeys/j262-wholesale-oversell-guard"),
    import("./journeys/j267-csrf-origin-check"),
    import("./journeys/j268-samesite-lax-cookie"),
    import("./journeys/j269-medusa-ssrf-update-guard"),
    import("./journeys/j270-medusa-ssrf-calltime-guard"),
    // === W39 PAY-8 (Coder C): PSP dispute/refund webhook events (renumbered J263->J271 by merger; A owns J263-265) ===
    import("./journeys/j271-psp-dispute-refund-webhooks"),
    // === W39 END ===
    // === W40 tenancy (Coder A): TEN-1/TEN-3/TEN-11/TEN-4 ===
    import("./journeys/j272-tenant-suspension-enforcement"),
    import("./journeys/j273-whatsapp-number-claim-conflict"),
    import("./journeys/j274-channel-hijack-db-backstop"),
    import("./journeys/j275-marketplace-register-seller-gate"),
    import("./journeys/j276-admin-cross-tenant-audit"),
    // === W40 Coder A END ===
    // === W40 Coder B (privacy + KYC depth): J277-J280 ===
    import("./journeys/j277-kyc-gdpr-erasure-export"),
    import("./journeys/j278-erasure-guards-regression"),
    import("./journeys/j279-ubo-sanctions-screening"),
    import("./journeys/j280-kyb-periodic-rescreen"),
    // === W40 Coder B END ===
    // === W40 messaging compliance + resilience (Coder C): J281-J285 ===
    import("./journeys/j281-stop-mid-conversation"),
    import("./journeys/j282-stop-resubscribe-telegram-parity"),
    import("./journeys/j283-template-rejected-webhook"),
    import("./journeys/j284-broadcast-circuit-breaker"),
    import("./journeys/j285-broadcast-resume"),
    import("./journeys/j286-buyer-installment-plan-creation"),
    import("./journeys/j287-down-payment-at-confirm"),
    import("./journeys/j288-installment-charge-exactly-once"),
    import("./journeys/j289-installment-dunning-on-failure"),
    import("./journeys/j290-token-consent-list-revoke"),
    import("./journeys/j291-one-tap-reorder-with-token"),
    import("./journeys/j292-fulfillment-gating-on-plan"),
    // === W40 Coder C END ===
    // === W41 (Coder B): customer wallet + split payments (UC-2/UC-3) ===
    import("./journeys/j293-wallet-credit-ledger"),
    import("./journeys/j294-refund-to-wallet-caps"),
    import("./journeys/j295-wallet-checkout-partial"),
    import("./journeys/j296-wallet-race-never-negative"),
    import("./journeys/j297-overpayment-auto-credit"),
    import("./journeys/j298-split-full-funding-confirm"),
    import("./journeys/j299-split-timeout-refunds"),
    // === W41 Coder B END ===
    // === W41 rma-fx (Coder C): RMA lifecycle + multi-currency display J300-J306 ===
    import("./journeys/j300-rma-full-lifecycle"),
    import("./journeys/j301-rma-chat-commands"),
    import("./journeys/j302-rma-escrow-pause"),
    import("./journeys/j303-rma-refund-caps"),
    import("./journeys/j304-rma-wallet-refund"),
    import("./journeys/j305-dual-currency-display"),
    import("./journeys/j306-ngn-charge-unchanged"),
    // === W41 Coder C END (merger owns registry count) ===
    // === W42 pipeline-durability (Coder A): messaging pipeline J307-J311 ===
    import("./journeys/j307-wa-webhook-dlq-persists"),
    import("./journeys/j308-publish-fail-never-silent-ack"),
    import("./journeys/j309-fluvio-side-publish"),
    import("./journeys/j310-wa-dlq-fallback-durability"),
    import("./journeys/j311-dead-letter-replay-path"),
    // === W42 Coder A END (merger owns registry count) ===
    // === W42 secrets/auth (Coder B): PLT-9/11/13/14 hardening J312-J316 ===
    import("./journeys/j312-secrets-key-rotation"),
    import("./journeys/j313-otp-cap-shared"),
    import("./journeys/j314-cron-jwt-scope"),
    import("./journeys/j315-cron-jti-replay"),
    import("./journeys/j316-tls-honest-errors"),
    // === W42 Coder B END ===
    // === W42 workflows (Coder C): temporal versioning + PG integration + pool leaks J317-J321 ===
    import("./journeys/j317-temporal-version-markers"),
    import("./journeys/j318-pg-integration-honest-skip"),
    import("./journeys/j319-pool-client-swap-leak"),
    import("./journeys/j320-pool-queue-bound"),
    import("./journeys/j321-temporal-stub-removed"),
    // === W42 Coder C END (merger owns registry count) ===
    // === W43 fulfillment (Coder A): partial fulfillment + backorders J322-J326 ===
    import("./journeys/j322-partial-fulfillment"),
    import("./journeys/j323-fulfill-qty-guard"),
    import("./journeys/j324-fulfill-idempotent-replay"),
    import("./journeys/j325-backorder-at-confirm"),
    import("./journeys/j326-restock-backorder-autofill"),
    // === W43 Coder A END (merger owns registry count) ===
    // === W43 exchanges (Coder B): exchanges + stock-adjustment audit J327-J331 ===
    import("./journeys/j327-exchange-positive-delta-payment-link"),
    import("./journeys/j328-exchange-negative-delta-wallet-credit"),
    import("./journeys/j329-exchange-illegal-transitions"),
    import("./journeys/j330-exchange-receive-stock-legs"),
    import("./journeys/j331-stock-adjustment-audit-trail"),
    // === W43 Coder B END (merger owns registry count) ===
    // === W43 dispatch (Coder C): POD photo + post-dispatch address change J332-J336 ===
    import("./journeys/j332-pod-courier-endpoint"),
    import("./journeys/j333-pod-wa-chat-photo"),
    import("./journeys/j334-requirepod-gates-delivered"),
    import("./journeys/j335-address-change-chat-approve"),
    import("./journeys/j336-address-change-terminal-paths"),
    // === W43 Coder C END (merger owns registry count) ===
    // === W44 giftcards-referrals (Coder A): gift cards + referrals J337-J341 ===
    import("./journeys/j337-giftcard-purchase-webhook-activates"),
    import("./journeys/j338-giftcard-redeem-claim-first"),
    import("./journeys/j339-giftcard-balance-chat-parity"),
    import("./journeys/j340-referral-reward-on-paid"),
    import("./journeys/j341-merchant-admin-and-referral-void"),
    // === W44 Coder A END (merger owns registry count) ===
    // === W44 preorders-offers (Coder B): pre-orders + haggling J342-J346 ===
    import("./journeys/j342-preorder-checkout-flip"),
    import("./journeys/j343-preorder-cancel-full-refund"),
    import("./journeys/j344-preorder-deposit-pct"),
    import("./journeys/j345-offer-accept-checkout"),
    import("./journeys/j346-offer-counter-expiry-tg"),
    // === W44 Coder B END (merger owns registry count) ===
    // === W44 deposits-subs-digital (Coder C): appointments + subscriptions + PIN digital goods J347-J351 ===
    import("./journeys/j347-appointment-booking-deposit"),
    import("./journeys/j348-appointment-cancel-noshow"),
    import("./journeys/j349-subscription-billing-tick"),
    import("./journeys/j350-subscription-failure-chat-lifecycle"),
    import("./journeys/j351-digital-pin-delivery"),
    // === W44 Coder C END (merger owns registry count) ===
    // === W45 webhook-core (Coder A1): MSG pipeline hardening J352-J356 ===
    import("./journeys/j352-multi-entry-fanout"),
    import("./journeys/j353-human-active-suppression"),
    import("./journeys/j354-dlq-retry-idempotent"),
    import("./journeys/j355-unknown-pnid-quarantine"),
    import("./journeys/j356-number-port-migration"),
    // === W45 Coder A1 END (merger owns registry count) ===
    // === W45 messaging-services (Coder A2): J357–J361 ===
    import("./journeys/j357-inbound-media-mirror"),
    import("./journeys/j358-monotonic-delivery-status"),
    import("./journeys/j359-suppression-list"),
    import("./journeys/j360-cart-recovery-window-gate"),
    import("./journeys/j361-ban-circuit-breaker"),
    // === END W45 messaging-services ===
    // === W45 money-scheduled (Coder B1): PAY-10/11/12/21/22 J362-J366 ===
    import("./journeys/j362-pay10-schedule-amount-validation"),
    import("./journeys/j363-pay11-stale-claim-reaper"),
    import("./journeys/j364-pay12-approval-expiry-resolves"),
    import("./journeys/j365-pay21-dispute-deadline-sweep"),
    import("./journeys/j366-pay22-stale-escrow-queue"),
    // === END W45 money-scheduled (merger owns registry count) ===
    // === W45 money-intents (Coder B2): quarantine + intent replay + exponents + transfer sweep + fallback verify J367-J371 ===
    import("./journeys/j367-payment-mismatch-quarantine"),
    import("./journeys/j368-stale-amount-replay-remint"),
    import("./journeys/j369-currency-exponent-dust"),
    import("./journeys/j370-stale-transfer-sweep"),
    import("./journeys/j371-fallback-verify-duplicate-refund"),
    // === W45 Coder B2 END (merger owns registry count) ===
    // === W45 money-ledger (Coder B3): FX outbox + PoT ledger/mandate lifecycle J372-J376 ===
    import("./journeys/j372-fx-outbox-deterministic-transfer"),
    import("./journeys/j373-fx-abort-compensation-poller"),
    import("./journeys/j374-fx-wallet-currency-guard"),
    import("./journeys/j375-pot-ledger-outbox-fee-currency"),
    import("./journeys/j376-pot-mandate-revocation-lifecycle"),
    // === W45 money-ledger END (merger owns registry count) ===
    // === W45 orders-p0 (Coder C) — J377–J381 (merger owns registry count) ===
    import("./journeys/j377-delivery-failure-escrow-pause"),
    import("./journeys/j378-goods-receipt-3way-match"),
    import("./journeys/j379-po-fulfill-stock-credit"),
    import("./journeys/j380-pin-cap-ssrf-guard"),
    import("./journeys/j381-buyer-cancel-weight-recon"),
    // === W45 orders-p0 END ===
    // === W45 go-rust-services (Coder D): J382-J386 ===
    import("./journeys/j382-hermes-approval-persistence"),
    import("./journeys/j383-hermes-callback-url-config"),
    import("./journeys/j384-chatwoot-real-reply-resolve"),
    import("./journeys/j385-message-processor-kafka-consumer"),
    import("./journeys/j386-notification-service-pipeline"),
    // === W45 go-rust-services END (merger owns registry count) ===
    // === W46 uc-money (Coder C): UC-11/15/16/26 — J397-J401 (merger owns registry count) ===
    import("./journeys/j397-auction-lifecycle"),
    import("./journeys/j398-auction-guards"),
    import("./journeys/j399-tipping"),
    import("./journeys/j400-donation-open-amount"),
    import("./journeys/j401-order-amendment"),
    // === END W46 uc-money ===
    // === W46 uc-docs (Coder D): J402-J406 ===
    import("./journeys/j402-customer-statement"),
    import("./journeys/j403-statement-chat-delivery"),
    import("./journeys/j404-proforma-convert"),
    import("./journeys/j405-agent-commission-payout"),
    import("./journeys/j406-tier-pricing"),
    // === W46 uc-docs END (merger owns registry count) ===
    // === W46 uc-ux (Coder E): J407-J411 ===
    import("./journeys/j407-venue-table-qr-ordering"),
    import("./journeys/j408-delivery-slot-capacity"),
    import("./journeys/j409-wishlist-price-drop"),
    import("./journeys/j410-gift-order-flow"),
    import("./journeys/j411-min-order-guard"),
    // === W46 uc-ux END (merger owns registry count) ===
    // === W46 inventory-depth (Coder F) — J412–J416 (merger owns registry count) ===
    import("./journeys/j412-barcode-scan"),
    import("./journeys/j413-variant-reservation"),
    import("./journeys/j414-warehouse-allocation"),
    import("./journeys/j415-delivery-claims"),
    import("./journeys/j416-fefo-expiry-sweep"),
    // === W46 inventory-depth END ===
    // === W46 orders-p2 (Coder G) === J417–J421.
    import("./journeys/j417-po-promised-date-breach"),
    import("./journeys/j418-product-recall-broadcast"),
    import("./journeys/j419-order-merge"),
    import("./journeys/j420-buyer-note-checkout"),
    import("./journeys/j421-po-breach-cron"),
    // === END W46 orders-p2 ===
    // === W46 kyc (Coder A): J387-J391 ===
    import("./journeys/j387-kyc-expiry-lifecycle"),
    import("./journeys/j388-kyc-appeal-four-eyes"),
    import("./journeys/j389-scoped-staff-capabilities"),
    import("./journeys/j390-member-removal-erasure-guard"),
    import("./journeys/j391-dsar-wallet-owner-gate"),
    // === W46 kyc END ===
    // === W46 privacy-consent (Coder B): J392-J396 (merger owns registry count) ===
    import("./journeys/j392-age-restricted-checkout"),
    import("./journeys/j393-consent-proof-regrant"),
    import("./journeys/j394-po-kyb-gates-dispute-routing"),
    import("./journeys/j395-device-factor-invite-binding"),
    import("./journeys/j396-kyb-sla-tax-versioning"),
    // === W46 privacy-consent END ===
    // === W46 platform-p2 (Coder H): J422-J426 ===
    import("./journeys/j422-internal-hmac-auth"),
    import("./journeys/j423-kafka-reconnect"),
    import("./journeys/j424-dbclock-premigration-dump"),
    import("./journeys/j425-kafka-topics-idempotence"),
    import("./journeys/j426-redact-language-picker"),
    // === W47 merchant ===
    import("./journeys/j427-legacy-complete-gate"),
    import("./journeys/j428-copilot-golive-kyb"),
    import("./journeys/j429-wizard-real-apis"),
    import("./journeys/j430-order-intake-lifecycle-gate"),
    import("./journeys/j431-number-conflict-savestep"),
    import("./journeys/j432-start-races"),
    import("./journeys/j433-progress-consolidation"),
    import("./journeys/j434-staff-invites"),
    import("./journeys/j435-appeal-payout"),
    import("./journeys/j436-telegram-validation-sweep"),
    // === END W47 merchant ===
    // === W46 platform-p2 END ===
    // === W47 buyer (Coder B): J437-J446 (merger owns registry count) ===
    import("./journeys/j437-age-gate-digits"),
    import("./journeys/j438-recycled-number-guard"),
    import("./journeys/j439-consent-gate-all-types"),
    import("./journeys/j440-tg-no-parity"),
    import("./journeys/j441-consent-proof-version"),
    import("./journeys/j442-identity-merge"),
    import("./journeys/j443-buyer-kyb-message"),
    import("./journeys/j444-erasure-coverage"),
    import("./journeys/j445-nlp-session-integrity"),
    import("./journeys/j446-sticky-locale-guard"),
    // === W47 stakeholders (Coder C): J447-J456 (merger owns registry count) ===
    import("./journeys/j447-owner-change-guard"),
    import("./journeys/j448-staff-invite-flow"),
    import("./journeys/j449-invite-resend-binding"),
    import("./journeys/j450-capability-fail-closed"),
    import("./journeys/j451-vendor-payee-vetting"),
    import("./journeys/j452-agent-self-dealing"),
    import("./journeys/j453-phone-uniqueness"),
    import("./journeys/j454-referral-clawback"),
    import("./journeys/j455-rider-onboarding"),
    import("./journeys/j456-stakeholder-notifications"),
    // === END W47 stakeholders ===
    // === W47 crosscutting (Coder D): J457-J466 ===
    import("./journeys/j457-owner-bootstrap"),
    import("./journeys/j458-device-factor-policy"),
    import("./journeys/j459-intake-abuse-caps"),
    import("./journeys/j460-cas-single-winner"),
    import("./journeys/j461-onboarding-i18n"),
    import("./journeys/j462-dormant-identity-reset"),
    import("./journeys/j463-consent-atomic-regrant"),
    import("./journeys/j464-age-attestation-proof"),
    import("./journeys/j465-referral-guards"),
    import("./journeys/j466-onboarding-p2-hardening"),
    // === W47 crosscutting END ===
    // === Temporal worker ⇄ platform contract (real HTTP + real DB) ===
    import("./journeys/j467-temporal-worker-platform"),
    import("./journeys/j468-temporal-enable-gate"),
    import("./journeys/j469-telegram-default-off"),
    import("./journeys/j470-telegram-setup-card"),
    import("./journeys/j471-telegram-whatsapp-parity"),
    import("./journeys/j472-late-payment-dead-order"),
    import("./journeys/j473-unified-webhook-quarantine"),
    import("./journeys/j474-wallet-topup-ledger-tracked"),
    import("./journeys/j475-escrow-hold-atomic-heal"),
    import("./journeys/j476-telegram-start-shows-menu"),
    import("./journeys/j477-telegram-order-and-pay"),
    import("./journeys/j478-deterministic-order-llm-down"),
    import("./journeys/j479-telegram-delivery-location-request"),
    import("./journeys/j480-cart-shortage-recovery"),
    import("./journeys/j481-session-language-self-correct"),
    import("./journeys/j482-support-handoff-contact-line"),
    import("./journeys/j483-deterministic-first-routing"),
    import("./journeys/j484-deterministic-dispute-routing"),
    import("./journeys/j485-wallet-currency-mismatch-refused"),
    // === W37 telegram END ===
    // === W38 money-integrity (Coder A): refund/escrow money integrity ===
    import("./journeys/j247-pay2-refund-idempotent-retry"),
    import("./journeys/j248-pay2-sweep-verify-first"),
    import("./journeys/j249-pay2-sweep-dead-letter"),
    import("./journeys/j250-pay3-refund-after-payout-clawback"),
    import("./journeys/j251-pay1-cumulative-cap-processed"),
    import("./journeys/j252-pay7-bulk-refund-provider-calls"),
    import("./journeys/j253-pay7-bulk-refund-pending-sweep"),
    import("./journeys/j254-pay9-scheduled-skip-paid-bill"),
    // === END W38 money-integrity (Coder A) ===
    // === W38 pot-recon ===
    import("./journeys/j255-pot-pending-charge-reconciles"),
    import("./journeys/j256-pot-timeout-no-double-charge"),
    import("./journeys/j257-pot-early-settle-lifecycle"),
    import("./journeys/j258-recon-settlement-dedupe-partial"),
    // === W38 pot-recon END ===
    // === W39 durability (Coder A): PLT-1/PLT-2/PLT-8 PVC + backups ===
    import("./journeys/j263-stateful-pvc-durability"),
    import("./journeys/j264-backup-cronjobs"),
    import("./journeys/j265-tigerbeetle-backup-doc"),
    // === END W39 durability (Coder A) ===
    // === END W35 infra-receivers ===
  ]);
  return mods.map((m) => m.journey as Journey);
}

export async function runAll(only?: string[]): Promise<JourneyResult[]> {
  const world = await bootWorld();
  const all = await loadJourneys();
  const selected = only?.length
    ? all.filter((j) => only.some((o) => j.id.toLowerCase() === o.toLowerCase() || j.id.toLowerCase() === `j${o.padStart(2, "0")}`))
    : all;

  const results: JourneyResult[] = [];
  for (const j of selected) {
    results.push(await runOneJourney(world, j));
  }
  writeTranscripts();
  return results;
}

export function writeTranscripts(): void {
  if (process.env.SIM_TRANSCRIPTS !== "off") {
    const dir = recorder.writeAll();
    if (!process.env.VITEST) console.log(`\ntranscripts → ${dir}`);
  }
}

/**
 * Run a single journey against an already-booted world: reset shared state,
 * record the transcript, run, then settle to quiescence (300ms of no
 * outbound/meta activity — deterministic, condition-based rather than a
 * fixed sleep). Never throws: failures are captured in the result so
 * per-journey test blocks can attribute them.
 */
export async function runOneJourney(world: World, j: Journey): Promise<JourneyResult> {
  const start = Date.now();
  await world.resetJourneyState();
  recorder.begin(j.id, j.name, j.feature);
  try {
    await j.run(world);
    await world.settle(300);
    recorder.end(true);
    return { id: j.id, name: j.name, feature: j.feature, pass: true, durationMs: Date.now() - start };
  } catch (e: any) {
    recorder.end(false);
    return {
      id: j.id, name: j.name, feature: j.feature, pass: false, durationMs: Date.now() - start,
      error: String(e?.stack ?? e?.message ?? e),
    };
  }
}

export function printMatrix(results: JourneyResult[]): void {
  const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s.padEnd(n));
  console.log("\n╔════════╦══════════════════════════════╦════════════════════════════╦════════╦═════════╗");
  console.log("║ ID     ║ Journey                      ║ Feature                    ║ Result ║ ms      ║");
  console.log("╠════════╬══════════════════════════════╬════════════════════════════╬════════╬═════════╣");
  for (const r of results) {
    console.log(
      `║ ${pad(r.id, 6)} ║ ${pad(r.name, 28)} ║ ${pad(r.feature, 26)} ║ ${r.pass ? "PASS  " : "FAIL  "} ║ ${String(r.durationMs).padEnd(7)} ║`,
    );
    if (!r.pass && r.error) {
      const lines = r.error.split("\n").slice(0, 8);
      for (const line of lines) console.log(`║        ↳ ${line.slice(0, 120)}`);
    }
  }
  console.log("╚════════╩══════════════════════════════╩════════════════════════════╩════════╩═════════╝");
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed}/${results.length} journeys PASS`);
}

async function main(): Promise<void> {
  const only = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const results = await runAll(only);
  printMatrix(results);
  process.exit(results.every((r) => r.pass) ? 0 : 1);
}

const isMain = !!process.argv[1] && /runner\.ts$/.test(process.argv[1].replace(/\\/g, "/"));
if (isMain) {
  main().catch((e) => {
    console.error("runner crashed:", e);
    process.exit(2);
  });
}
