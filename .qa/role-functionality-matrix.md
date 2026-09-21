# Role × Functionality Matrix

Generated from `server/routers/**/*.ts` via `authzScan.lib.ts` (915 procedures across 127 router files).

Columns: procedure kind = the base-procedure access tier it's built on (this is the FIRST line of defense — public/protected/internal/operator/analyst/admin); guard mechanism = the specific in-body check found (second line of defense for protectedProcedure-based ones, which carry no automatic tenant scoping).

**Summary: 56 unguarded procedure(s) found (1 money-relevant).**

Rows flagged **⚠ UNGUARDED** are procedures the static scanner could not find ANY tenant/role guard for and that were NOT in the reviewed exemption allowlist — these are exactly the class QA-005/006/011 hunted for manually; this table is the systematic version of that same check, covering all 915 procedures instead of a sample.

## `agent.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| stats | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| health | query | protectedProcedure | NONE FOUND |  |  | ⚠ UNGUARDED |
| listAuditLog | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |

## `ai.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| chat | mutation | protectedProcedure | NONE FOUND |  |  | ⚠ UNGUARDED |

## `alertRules.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| list | query | protectedProcedure | NONE FOUND |  |  | ⚠ UNGUARDED |
| create | mutation | adminProcedure | adminProcedure (role=admin + Permify) |  | yes | OK |
| update | mutation | adminProcedure | adminProcedure (role=admin + Permify) |  | yes | OK |
| toggle | mutation | adminProcedure | adminProcedure (role=admin + Permify) |  | yes | OK |
| delete | mutation | adminProcedure | adminProcedure (role=admin + Permify) |  | yes | OK |
| getRuleTypeMeta | query | protectedProcedure | NONE FOUND |  |  | ⚠ UNGUARDED |
| seedDefaults | mutation | adminProcedure | adminProcedure (role=admin + Permify) |  |  | OK |
| listEvents | query | protectedProcedure | exempt: platform-scoped global alert rules (heartbeat/recon ops config), not per-tenant data |  | yes | OK |

## `analytics.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| platformOverview | query | adminProcedure | adminProcedure (role=admin + Permify) |  |  | OK |
| revenueTrend | query | adminProcedure | adminProcedure (role=admin + Permify) |  |  | OK |
| conversationSplitTrend | query | adminProcedure | adminProcedure (role=admin + Permify) |  |  | OK |
| tenantDashboard | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |

## `analyticsBI.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| listCohorts | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| upsertCohort | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| listChurnRisks | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| upsertChurnPrediction | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| markInterventionSent | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| biSummary | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |

## `apisix.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| listLive | query | adminProcedure | adminProcedure (role=admin + Permify) |  |  | OK |
| deleteRoute | mutation | adminProcedure | adminProcedure (role=admin + Permify) |  | yes | OK |
| syncAll | mutation | adminProcedure | adminProcedure (role=admin + Permify) |  |  | OK |
| health | query | protectedProcedure | NONE FOUND |  |  | ⚠ UNGUARDED |

## `approvals.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| getPolicy | query | analystProcedure | analystProcedure (owner|operator|analyst) |  | yes | OK |
| list | query | analystProcedure | analystProcedure (owner|operator|analyst) |  | yes | OK |
| get | mutation | analystProcedure | analystProcedure (owner|operator|analyst) |  | yes | OK |

## `arInvoices.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| list | query | analystProcedure | analystProcedure (owner|operator|analyst) | yes | yes | OK |
| get | mutation | analystProcedure | analystProcedure (owner|operator|analyst) | yes | yes | OK |
| getByLinkRef | query | publicProcedure | publicProcedure (no auth) | yes |  | OK |

## `audit.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| export | query | adminProcedure | adminProcedure (role=admin + Permify) |  | yes | OK |

## `b2b.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| listPriceTiers | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| upsertPriceTier | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| deletePriceTier | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| listRfqs | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| submitRfq | mutation | publicProcedure | publicProcedure (no auth) |  | yes | OK |
| quoteRfq | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| updateRfqStatus | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| listPurchaseOrders | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| createPurchaseOrder | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| approvePurchaseOrder | mutation | protectedProcedure | assertMoneyAccess (owner|operator|finance) |  | yes | OK |
| updatePoStatus | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| b2bStats | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |

## `broadcast.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| list | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| get | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| create | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| send | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| resume | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| cancel | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| stats | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| preview | mutation | protectedProcedure | NONE FOUND |  |  | ⚠ UNGUARDED |
| simulateDelivery | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| trainUpliftModel | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| upliftModelStatus | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |

## `broadcastAb.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| createAbTest | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| getAbResults | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| selectWinner | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| autoSelectWinner | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| listAbTests | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |

## `buyerCredit.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| getInstallmentConfig | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| setInstallmentConfig | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| listPlans | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| planForOrder | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |

## `cashflow.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| forecast | query | analystProcedure | analystProcedure (owner|operator|analyst) |  | yes | OK |
| snapshots | query | analystProcedure | analystProcedure (owner|operator|analyst) |  | yes | OK |

## `catalogAI.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| listDrafts | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| getDraft | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| updateDraft | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| publishDraft | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| rejectDraft | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| suggestPrice | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |

## `catalogBootstrap.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| bootstrapFromImage | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| getDraft | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| confirmDraft | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| rejectDraft | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |

## `channels.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| processUssd | mutation | internalProcedure | internalProcedure (shared-secret) |  | yes | OK |
| processSms | mutation | internalProcedure | internalProcedure (shared-secret) |  | yes | OK |
| processTelegram | mutation | internalProcedure | internalProcedure (shared-secret) |  | yes | OK |
| processInstagram | mutation | internalProcedure | internalProcedure (shared-secret) |  | yes | OK |
| listMessages | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| channelStats | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |

## `cod.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| board | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| transition | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| codConfirmCollection | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| settle | mutation | protectedProcedure | assertMoneyAccess (owner|operator|finance) | yes | yes | OK |
| codReconciliation | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| paymentSummary | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| events | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| createOfflineOrder | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |

## `cogsDispute.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| submit | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| list | query | adminProcedure | adminProcedure (role=admin + Permify) |  |  | OK |
| review | mutation | protectedProcedure | inline role check |  | yes | OK |
| getForTenant | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |

## `compliance.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| listTaxFilings | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| createTaxFiling | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| submitTaxFiling | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| listCacRegistrations | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| createCacRegistration | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| updateCacStatus | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| listProcurementBids | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| createProcurementBid | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| submitProcurementBid | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| listGovernmentContracts | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| complianceSummary | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| verifyAuditChain | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| accessReview | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| retentionPolicies | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| upsertRetentionPolicy | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| purgePreview | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| purgeExecute | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| exportCustomerData | query | protectedProcedure | assertTenantAccess (any membership) | yes | yes | OK |
| listIncidents | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| createIncident | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| updateIncident | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| anomalyScan | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| anomalyAlerts | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| updateAnomalyAlert | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| scanGraphCollusion | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| graphAlerts | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| updateGraphAlert | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| incidentStatus | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |

## `consents.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| list | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| exportCsv | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| stats | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| recordWithdrawal | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |

## `conversation.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| list | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| stats | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| getMessages | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| sendMessage | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| updateStatus | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |

## `copilot.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| triageIncident | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| ask | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| history | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |

## `credit.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| score | query | protectedProcedure | domain guard: assertMerchantAccess( |  | yes | OK |
| offers | query | protectedProcedure | domain guard: assertMerchantAccess( |  | yes | OK |
| accept | mutation | protectedProcedure | domain guard: assertMerchantAccess( |  |  | OK |
| loans | query | protectedProcedure | domain guard: assertMerchantAccess( |  | yes | OK |
| repay | mutation | protectedProcedure | domain guard: assertMerchantAccess( | yes |  | OK |
| certificate | mutation | protectedProcedure | domain guard: assertMerchantAccess( |  | yes | OK |

## `creditFacilities.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| createFacility | mutation | adminProcedure | adminProcedure (role=admin + Permify) |  |  | OK |
| listFacilities | query | adminProcedure | adminProcedure (role=admin + Permify) |  |  | OK |
| assignAccount | mutation | adminProcedure | adminProcedure (role=admin + Permify) |  | yes | OK |
| generateTape | query | adminProcedure | adminProcedure (role=admin + Permify) |  | yes | OK |
| covenantCheck | query | adminProcedure | adminProcedure (role=admin + Permify) |  | yes | OK |
| tapeEmailPreview | query | adminProcedure | adminProcedure (role=admin + Permify) |  | yes | OK |

## `creditRepay.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| requestRepaymentLink | mutation | protectedProcedure | assertTenantAccess (any membership) | yes | yes | OK |

## `crm.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| refreshScores | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| pipelineSummary | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| atRiskList | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| trainLeadModel | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| leadModelStatus | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| getScoreBreakdown | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| createWinBackCampaign | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |

## `ctwa.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| getLinks | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| createCampaign | mutation | protectedProcedure | assertTenantAccess (any membership) |  |  | OK |
| deleteCampaign | mutation | protectedProcedure | assertTenantAccess (any membership) |  |  | OK |

## `customers.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| create | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| list | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |

## `delivery.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| listAdapters | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| listConfigs | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| configureCourier | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| quote | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| book | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| advance | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| sync | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| list | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| sweep | mutation | internalProcedure | internalProcedure (shared-secret) |  | yes | OK |
| trackByToken | query | publicProcedure | publicProcedure (no auth) |  |  | OK |

## `deliveryReceipts.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| ingestStatusUpdate | mutation | internalProcedure | internalProcedure (shared-secret) |  | yes | OK |
| getMetrics | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| getLatestDeliveryStatuses | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |

## `embedded.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| createClient | mutation | adminProcedure | adminProcedure (role=admin + Permify) |  | yes | OK |
| suspendClient | mutation | adminProcedure | adminProcedure (role=admin + Permify) |  | yes | OK |
| rotateKey | mutation | adminProcedure | adminProcedure (role=admin + Permify) |  | yes | OK |
| listClients | query | adminProcedure | adminProcedure (role=admin + Permify) |  | yes | OK |

## `embeddedSignup.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| exchange | mutation | operatorProcedure | operatorProcedure (owner|operator) |  |  | OK |
| complete | query | operatorProcedure | operatorProcedure (owner|operator) |  | yes | OK |

## `erpProvision.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| provision | mutation | operatorProcedure | operatorProcedure (owner|operator) |  | yes | OK |
| getState | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| listIntents | query | protectedProcedure | NONE FOUND |  |  | ⚠ UNGUARDED |
| applyConfig | mutation | operatorProcedure | operatorProcedure (owner|operator) |  | yes | OK |

## `escalation.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| openConversation | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| escalate | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| resolve | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| releaseToBot | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| reply | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| get | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |

## `escrow.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| getConfig | query | protectedProcedure | NONE FOUND |  |  | ⚠ UNGUARDED |
| setConfig | mutation | adminProcedure | adminProcedure (role=admin + Permify) | yes |  | OK |
| createHold | mutation | protectedProcedure | assertTenantAccess (any membership) | yes | yes | OK |
| confirmDelivery | mutation | protectedProcedure | assertMoneyAccess (owner|operator|finance) | yes | yes | OK |
| buyerConfirm | mutation | protectedProcedure | domain guard: assertBuyerOrAdmin( | yes | yes | OK |
| bankSettlementConfirmed | mutation | adminProcedure | adminProcedure (role=admin + Permify) | yes | yes | OK |
| initiateRefund | mutation | adminProcedure | adminProcedure (role=admin + Permify) | yes | yes | OK |
| getByOrder | query | protectedProcedure | assertTenantAccess (any membership) | yes | yes | OK |
| listAll | query | protectedProcedure | inline role check |  | yes | OK |
| getStats | query | adminProcedure | adminProcedure (role=admin + Permify) |  |  | OK |
| getTimeline | query | protectedProcedure | assertTenantAccess (any membership) | yes | yes | OK |
| bulkUpdateState | mutation | adminProcedure | adminProcedure (role=admin + Permify) | yes |  | OK |
| raise | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| list | query | protectedProcedure | inline role check |  | yes | OK |
| getByOrder | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| review | mutation | adminProcedure | adminProcedure (role=admin + Permify) | yes | yes | OK |
| escalate | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| escalationSlaStats | query | adminProcedure | adminProcedure (role=admin + Permify) |  |  | OK |
| getBalance | query | protectedProcedure | assertTenantAccess (any membership) | yes | yes | OK |
| listBanks | query | protectedProcedure | NONE FOUND |  |  | ⚠ UNGUARDED |
| resolveAccount | query | protectedProcedure | NONE FOUND |  |  | ⚠ UNGUARDED |
| listTransactions | mutation | protectedProcedure | assertTenantAccess (any membership) | yes | yes | OK |
| rejectWithdrawal | mutation | adminProcedure | adminProcedure (role=admin + Permify) | yes | yes | OK |
| getStats | query | adminProcedure | adminProcedure (role=admin + Permify) |  |  | OK |
| exportLedgerCsv | query | protectedProcedure | assertTenantAccess (any membership) | yes | yes | OK |
| topUp | mutation | protectedProcedure | assertTenantAccess (any membership) | yes | yes | OK |
| reconcileTopUps | mutation | adminProcedure | adminProcedure (role=admin + Permify) |  |  | OK |
| add | mutation | protectedProcedure | assertTenantAccess (any membership) | yes | yes | OK |
| list | query | protectedProcedure | assertTenantAccess (any membership) | yes | yes | OK |

## `evidencePortal.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| generateToken | mutation | protectedProcedure | session-tenant scoping |  | yes | OK |
| listTokens | query | protectedProcedure | session-tenant scoping |  | yes | OK |
| listSubmissions | query | protectedProcedure | session-tenant scoping |  | yes | OK |
| revokeToken | mutation | protectedProcedure | session-tenant scoping | yes |  | OK |

## `exchanges.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| list | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| request | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| decide | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| transition | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| receive | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |

## `fineTune.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| listRuns | query | publicProcedure | publicProcedure (no auth) |  |  | OK |
| getRun | query | publicProcedure | publicProcedure (no auth) |  | yes | OK |

## `fraudCase.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| list | query | adminProcedure | adminProcedure (role=admin + Permify) |  | yes | OK |
| retryFailed | mutation | adminProcedure | adminProcedure (role=admin + Permify) |  | yes | OK |
| markFiled | mutation | adminProcedure | adminProcedure (role=admin + Permify) |  | yes | OK |
| processQueue | mutation | adminProcedure | adminProcedure (role=admin + Permify) |  |  | OK |

## `fxPayouts.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| list | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |

## `geo.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| discover | query | publicProcedure | publicProcedure (no auth) |  |  | OK |
| listCategories | query | publicProcedure | publicProcedure (no auth) |  |  | OK |
| setLocation | mutation | protectedProcedure | session-tenant scoping |  |  | OK |
| getLocation | query | protectedProcedure | session-tenant scoping |  |  | OK |
| setDiscoverable | mutation | protectedProcedure | session-tenant scoping |  |  | OK |
| createSponsoredListing | mutation | protectedProcedure | session-tenant scoping |  |  | OK |
| listSponsoredListings | query | protectedProcedure | session-tenant scoping |  |  | OK |
| pauseSponsoredListing | mutation | protectedProcedure | session-tenant scoping |  | yes | OK |
| resumeSponsoredListing | mutation | protectedProcedure | session-tenant scoping |  | yes | OK |

## `giftCards.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| list | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| transactions | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| issue | mutation | protectedProcedure | assertTenantAccess (any membership) | yes | yes | OK |
| disable | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| adjust | mutation | protectedProcedure | assertMoneyAccess (owner|operator|finance) |  | yes | OK |
| events | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| setRewardCents | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |

## `groupBuy.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| createDeal | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| listDeals | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| dealDetail | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| cancelDeal | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| sweep | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| refundFailures | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| getDealPublic | query | publicProcedure | publicProcedure (no auth) |  | yes | OK |
| joinDeal | mutation | publicProcedure | publicProcedure (no auth) | yes | yes | OK |
| myParticipation | query | publicProcedure | publicProcedure (no auth) | yes | yes | OK |

## `heartbeat.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| inventorySync | mutation | internalProcedure | internalProcedure (shared-secret) |  |  | OK |

## `hermes.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| getConfig | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| saveConfig | mutation | operatorProcedure | operatorProcedure (owner|operator) |  | yes | OK |
| completeTour | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| getStatus | query | protectedProcedure | NONE FOUND |  |  | ⚠ UNGUARDED |
| getEventLog | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| getPOQueue | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| approvePO | mutation | protectedProcedure | exempt: capability-token PO approval link: lookup requires matching approvalToken (bearer capability) |  | yes | OK |
| rejectPO | mutation | protectedProcedure | exempt: capability-token PO approval link: lookup requires matching approvalToken (bearer capability) |  | yes | OK |
| fireEvent | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| layerHealth | query | protectedProcedure | NONE FOUND |  |  | ⚠ UNGUARDED |
| healthHistory | query | protectedProcedure | NONE FOUND |  |  | ⚠ UNGUARDED |

## `i18n.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| listLocales | query | protectedProcedure | NONE FOUND |  |  | ⚠ UNGUARDED |
| getTenantLocale | query | protectedProcedure | session-tenant scoping |  |  | OK |
| setTenantLocale | mutation | protectedProcedure | session-tenant scoping |  |  | OK |
| listOverrides | query | protectedProcedure | session-tenant scoping |  |  | OK |
| setOverride | mutation | protectedProcedure | session-tenant scoping |  |  | OK |
| removeOverride | mutation | protectedProcedure | session-tenant scoping |  |  | OK |
| setCustomerLocale | mutation | internalProcedure | internalProcedure (shared-secret) |  | yes | OK |

## `infra.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| infraHealth | query | protectedProcedure | NONE FOUND |  |  | ⚠ UNGUARDED |
| recordWafEvent | mutation | internalProcedure | internalProcedure (shared-secret) |  | yes | OK |
| systemRecentErrors | query | adminProcedure | adminProcedure (role=admin + Permify) |  |  | OK |
| listWafEvents | query | adminProcedure | adminProcedure (role=admin + Permify) |  | yes | OK |
| recordFluvioEvent | mutation | internalProcedure | internalProcedure (shared-secret) |  | yes | OK |
| listFluvioEvents | query | adminProcedure | adminProcedure (role=admin + Permify) |  |  | OK |
| listApisixRoutes | query | adminProcedure | adminProcedure (role=admin + Permify) |  | yes | OK |
| upsertApisixRoute | mutation | adminProcedure | adminProcedure (role=admin + Permify) |  | yes | OK |
| listDaprEvents | query | adminProcedure | adminProcedure (role=admin + Permify) |  |  | OK |
| listLakehouseRuns | query | adminProcedure | adminProcedure (role=admin + Permify) |  |  | OK |
| triggerLakehousePipeline | mutation | adminProcedure | adminProcedure (role=admin + Permify) |  | yes | OK |
| provisionTbAccount | mutation | adminProcedure | adminProcedure (role=admin + Permify) | yes | yes | OK |
| listTbAccounts | query | adminProcedure | adminProcedure (role=admin + Permify) | yes | yes | OK |
| triggerReconciliation | mutation | adminProcedure | adminProcedure (role=admin + Permify) |  |  | OK |
| getLastReconciliation | query | adminProcedure | adminProcedure (role=admin + Permify) |  |  | OK |
| recordReconRun | mutation | internalProcedure | internalProcedure (shared-secret) |  | yes | OK |

## `integrations.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| getConfig | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| setConfig | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| testConnection | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| syncStatus | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| resync | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| listEvents | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| adminReencryptSecrets | mutation | adminProcedure | adminProcedure (role=admin + Permify) |  |  | OK |

## `inventory.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| getStockLevels | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| getStockAlerts | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| syncFromOdoo | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| reserveStock | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| releaseReservation | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| adjustmentHistory | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| getSyncHistory | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |

## `inventoryDepth.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| scanBarcode | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| upsertVariant | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| listVariants | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| receiveVariantStock | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| createWarehouse | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| listWarehouses | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| listWarehouseStock | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| receiveBatch | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| listBatches | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| runExpirySweep | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| createClaim | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| transitionClaim | mutation | protectedProcedure | assertTenantAccess (any membership) | yes | yes | OK |
| listClaims | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |

## `invoice.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| generate | mutation | protectedProcedure | assertTenantAccess (any membership) | yes | yes | OK |
| list | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| initiatePaystackPayment | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| send | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| markPaid | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| get | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| stats | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |

## `journeys.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| list | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| get | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| create | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| update | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| setStatus | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| listRuns | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| enroll | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |

## `keycloak.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| saveConfig | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| getConfig | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| testConnection | mutation | operatorProcedure | operatorProcedure (owner|operator) |  | yes | OK |
| getLoginUrl | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| exchangeCode | mutation | publicProcedure | publicProcedure (no auth) |  | yes | OK |
| rebindSsoProfile | mutation | adminProcedure | adminProcedure (role=admin + Permify) |  | yes | OK |
| listSsoProfiles | query | adminProcedure | adminProcedure (role=admin + Permify) |  |  | OK |

## `kyc.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| getOrCreateApplication | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| getApplication | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| updateApplication | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| submit | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| uploadDocument | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| listAll | query | adminProcedure | adminProcedure (role=admin + Permify) |  |  | OK |
| review | mutation | adminProcedure | adminProcedure (role=admin + Permify) |  | yes | OK |
| appeal | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| createLivenessSession | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| stats | query | adminProcedure | adminProcedure (role=admin + Permify) |  |  | OK |

## `labelStudio.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| getConfig | query | protectedProcedure | NONE FOUND |  |  | OK |
| saveConfig | mutation | protectedProcedure | NONE FOUND |  | yes | OK |
| testConnection | mutation | protectedProcedure | NONE FOUND |  |  | OK |
| exportSessions | mutation | protectedProcedure | NONE FOUND |  |  | OK |
| stats | query | protectedProcedure | NONE FOUND |  |  | OK |

## `logistics.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| getProviders | query | protectedProcedure | NONE FOUND |  |  | ⚠ UNGUARDED |
| createShipment | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| getShipment | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| listShipments | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| simulateDelivery | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| getStats | query | adminProcedure | adminProcedure (role=admin + Permify) |  |  | OK |

## `loyalty.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| getRules | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| setRules | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| balance | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| award | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| redeem | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| previewRedemption | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| ledger | query | protectedProcedure | assertTenantAccess (any membership) | yes | yes | OK |
| sweep | mutation | internalProcedure | internalProcedure (shared-secret) |  | yes | OK |

## `manufacturerPrograms.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| create | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| update | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| setStatus | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| get | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| list | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| assignAccount | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| unassignAccount | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| programBook | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| checkDrawAllowed | query | protectedProcedure | assertTenantAccess (any membership) | yes | yes | OK |
| suggestLimitForProgram | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| programTape | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |

## `marketplace.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| registerSeller | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| listSellers | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| getSeller | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| updateSellerStatus | mutation | adminProcedure | adminProcedure (role=admin + Permify) |  | yes | OK |
| updateSellerCommission | mutation | adminProcedure | adminProcedure (role=admin + Permify) | yes | yes | OK |
| recordCommission | mutation | protectedProcedure | assertTenantAccess (any membership) | yes | yes | OK |
| listCommissions | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| settleCommission | mutation | protectedProcedure | assertMoneyAccess (owner|operator|finance) | yes | yes | OK |
| marketplaceStats | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| listConnectors | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| installConnector | mutation | operatorProcedure | operatorProcedure (owner|operator) |  | yes | OK |
| uninstallConnector | mutation | operatorProcedure | operatorProcedure (owner|operator) |  | yes | OK |
| connectorHealth | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |

## `medusa.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| isConfigured | query | publicProcedure | publicProcedure (no auth) |  |  | OK |
| listProducts | query | publicProcedure | publicProcedure (no auth) |  |  | OK |
| getProduct | query | publicProcedure | publicProcedure (no auth) |  | yes | OK |
| listCollections | query | publicProcedure | publicProcedure (no auth) |  |  | OK |
| listCategories | query | publicProcedure | publicProcedure (no auth) |  |  | OK |
| listRegions | query | publicProcedure | publicProcedure (no auth) |  |  | OK |
| listOrders | query | adminProcedure | adminProcedure (role=admin + Permify) |  | yes | OK |
| getOrder | query | adminProcedure | adminProcedure (role=admin + Permify) |  | yes | OK |
| listPriceLists | query | protectedProcedure | NONE FOUND |  |  | ⚠ UNGUARDED |
| createPriceList | mutation | adminProcedure | adminProcedure (role=admin + Permify) |  | yes | OK |
| listPromotions | query | protectedProcedure | NONE FOUND |  |  | ⚠ UNGUARDED |
| createCart | mutation | publicProcedure | publicProcedure (no auth) |  | yes | OK |
| addToCart | mutation | publicProcedure | publicProcedure (no auth) |  | yes | OK |
| getCart | query | publicProcedure | publicProcedure (no auth) |  | yes | OK |
| getCatalogForPicker | query | protectedProcedure | NONE FOUND |  |  | ⚠ UNGUARDED |
| importProductsToMenu | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| configure | mutation | operatorProcedure | operatorProcedure (owner|operator) |  | yes | OK |
| testConnection | mutation | protectedProcedure | inline role check |  | yes | OK |
| getTenantConfig | query | protectedProcedure | NONE FOUND |  |  | ⚠ UNGUARDED |
| getMapping | query | protectedProcedure | session-tenant scoping |  |  | OK |
| upsertMapping | mutation | protectedProcedure | session-tenant scoping |  | yes | OK |
| testMapping | mutation | protectedProcedure | session-tenant scoping |  |  | OK |
| backfillCatalog | mutation | protectedProcedure | session-tenant scoping |  |  | OK |
| setCatalogSource | mutation | protectedProcedure | session-tenant scoping |  |  | OK |
| bridgeOrder | mutation | protectedProcedure | session-tenant scoping |  | yes | OK |
| getOrderBridge | query | protectedProcedure | session-tenant scoping |  | yes | OK |

## `medusaOnboarding.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| list | query | protectedProcedure | getTenantId(ctx) helper |  |  | OK |
| addProduct | mutation | protectedProcedure | getTenantId(ctx) helper |  | yes | OK |
| importFromCatalog | mutation | protectedProcedure | getTenantId(ctx) helper |  |  | OK |
| pushToMedusa | mutation | protectedProcedure | getTenantId(ctx) helper |  |  | OK |
| remove | mutation | protectedProcedure | getTenantId(ctx) helper |  | yes | OK |
| uploadImage | mutation | protectedProcedure | getTenantId(ctx) helper |  |  | OK |
| stats | query | protectedProcedure | getTenantId(ctx) helper |  |  | OK |

## `membership.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| list | query | operatorProcedure | operatorProcedure (owner|operator) |  | yes | OK |
| myMembership | query | operatorProcedure | operatorProcedure (owner|operator) |  | yes | OK |
| add | mutation | operatorProcedure | operatorProcedure (owner|operator) |  |  | OK |
| remove | mutation | operatorProcedure | operatorProcedure (owner|operator) |  |  | OK |

## `menu.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| list | query | protectedProcedure | getTenantId(ctx) helper |  |  | OK |
| get | query | protectedProcedure | getTenantId(ctx) helper |  | yes | OK |
| create | mutation | protectedProcedure | getTenantId(ctx) helper |  |  | OK |
| update | mutation | protectedProcedure | getTenantId(ctx) helper |  | yes | OK |
| delete | mutation | protectedProcedure | getTenantId(ctx) helper |  | yes | OK |
| addItem | mutation | protectedProcedure | getTenantId(ctx) helper |  | yes | OK |
| updateItem | mutation | protectedProcedure | getTenantId(ctx) helper |  | yes | OK |
| deleteItem | mutation | protectedProcedure | getTenantId(ctx) helper |  | yes | OK |
| reorderItems | mutation | protectedProcedure | getTenantId(ctx) helper |  | yes | OK |
| getDataSources | query | protectedProcedure | getTenantId(ctx) helper |  |  | OK |
| autoPopulate | mutation | protectedProcedure | getTenantId(ctx) helper | yes | yes | OK |
| publish | mutation | protectedProcedure | getTenantId(ctx) helper |  | yes | OK |
| pushToWhatsApp | mutation | protectedProcedure | getTenantId(ctx) helper |  | yes | OK |
| unpublish | mutation | protectedProcedure | getTenantId(ctx) helper |  | yes | OK |
| getAssignments | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| assignToTenant | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| unassignFromTenant | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |

## `metering.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| getUsage | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| getPlan | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| setPlan | mutation | adminProcedure | adminProcedure (role=admin + Permify) |  | yes | OK |
| getWaQuality | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |

## `mlOps.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| getExperiments | query | protectedProcedure | NONE FOUND |  |  | ⚠ UNGUARDED |
| getMlflowRuns | query | protectedProcedure | exempt: platform ML-ops surface (mlflow experiments/model AB tests), operator tooling not tenant data |  | yes | OK |
| getAllRuns | query | protectedProcedure | NONE FOUND |  |  | ⚠ UNGUARDED |
| getTrainingStatus | query | protectedProcedure | NONE FOUND |  |  | ⚠ UNGUARDED |
| getDriftMetrics | query | protectedProcedure | NONE FOUND |  |  | ⚠ UNGUARDED |
| getAbComparison | query | protectedProcedure | NONE FOUND |  |  | ⚠ UNGUARDED |
| triggerRetraining | mutation | adminProcedure | adminProcedure (role=admin + Permify) |  |  | OK |
| getDataPipelineStatus | query | protectedProcedure | NONE FOUND |  |  | ⚠ UNGUARDED |
| getMetricHistory | query | protectedProcedure | exempt: platform ML-ops surface (mlflow experiments/model AB tests), operator tooling not tenant data |  | yes | OK |
| getDriftAlerts | query | protectedProcedure | NONE FOUND |  |  | ⚠ UNGUARDED |
| getModelPerformance | query | protectedProcedure | NONE FOUND |  |  | ⚠ UNGUARDED |
| triggerRealDataRetrain | mutation | adminProcedure | adminProcedure (role=admin + Permify) | yes |  | OK |
| list | query | protectedProcedure | NONE FOUND |  |  | ⚠ UNGUARDED |
| create | mutation | protectedProcedure | NONE FOUND |  |  | ⚠ UNGUARDED |
| conclude | mutation | protectedProcedure | exempt: platform ML-ops surface (mlflow experiments/model AB tests), operator tooling not tenant data |  | yes | OK |
| triggerRetrainingReal | mutation | adminProcedure | adminProcedure (role=admin + Permify) |  |  | OK |
| list | query | protectedProcedure | NONE FOUND |  |  | ⚠ UNGUARDED |
| create | mutation | protectedProcedure | NONE FOUND |  |  | ⚠ UNGUARDED |

## `mobileMoney.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| initiate | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| handleCallback | mutation | publicProcedure | publicProcedure (no auth) |  |  | OK |
| listTransactions | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| stats | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |

## `nlp.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| processMessage | mutation | internalProcedure | internalProcedure (shared-secret) | yes | yes | OK |
| getSession | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| listSessions | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| resetSession | mutation | protectedProcedure | domain guard: assertNlpSessionAccess( |  | yes | OK |
| simulate | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| queueOfflineMessage | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| syncOfflineQueue | mutation | protectedProcedure | domain guard: assertNlpSessionAccess( |  | yes | OK |
| getOfflineQueueCount | query | protectedProcedure | domain guard: assertNlpSessionAccess( |  | yes | OK |
| getQueuedMessages | query | protectedProcedure | domain guard: assertNlpSessionAccess( |  | yes | OK |
| getOrderTimeline | query | protectedProcedure | assertTenantAccess (any membership) |  |  | OK |

## `notifications.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| list | query | protectedProcedure | session-tenant scoping |  |  | OK |
| getUnreadCount | query | protectedProcedure | session-tenant scoping |  |  | OK |
| markRead | mutation | protectedProcedure | session-tenant scoping |  | yes | OK |
| markAllRead | mutation | protectedProcedure | session-tenant scoping |  |  | OK |
| adminList | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |

## `odoo.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| getConfig | query | protectedProcedure | getTenantId(ctx) helper |  |  | OK |
| saveConfig | mutation | protectedProcedure | getTenantId(ctx) helper |  |  | OK |
| configure | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| testConnection | mutation | protectedProcedure | getTenantId(ctx) helper |  |  | OK |
| syncAll | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| listProducts | query | protectedProcedure | getTenantId(ctx) helper |  |  | OK |
| listOrders | query | protectedProcedure | getTenantId(ctx) helper |  |  | OK |
| listInvoices | query | protectedProcedure | getTenantId(ctx) helper |  |  | OK |
| sendWhatsApp | mutation | protectedProcedure | getTenantId(ctx) helper |  | yes | OK |

## `odooMedusaBridge.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| list | query | protectedProcedure | getTenantId(ctx) helper |  |  | OK |
| upsertMapping | mutation | protectedProcedure | domain guard: assertBridgeAccess( |  | yes | OK |
| syncOdooToMedusa | mutation | protectedProcedure | domain guard: assertBridgeAccess( |  |  | OK |
| listSyncHistory | query | protectedProcedure | getTenantId(ctx) helper |  |  | OK |
| stats | query | protectedProcedure | getTenantId(ctx) helper |  |  | OK |

## `onboarding.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| getBillingPlans | query | protectedProcedure | NONE FOUND |  |  | ⚠ UNGUARDED |
| getBusinessTypes | query | protectedProcedure | NONE FOUND |  |  | ⚠ UNGUARDED |
| getProgress | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| saveStep | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| complete | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| listWithStatus | query | adminProcedure | adminProcedure (role=admin + Permify) |  |  | OK |
| sendProgressEmail | mutation | adminProcedure | adminProcedure (role=admin + Permify) |  | yes | OK |
| start | mutation | protectedProcedure | session-tenant scoping |  |  | OK |
| getStatus | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| updateStep | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| validate | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| activate | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| retryValidation | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |

## `onboardingCopilot.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| startSession | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| postMessage | mutation | protectedProcedure | domain guard: assertSessionAccess( |  | yes | OK |
| approveProposal | mutation | protectedProcedure | domain guard: assertSessionAccess( |  | yes | OK |
| editProposal | mutation | protectedProcedure | domain guard: assertSessionAccess( |  | yes | OK |
| getSession | query | protectedProcedure | domain guard: assertSessionAccess( |  | yes | OK |
| listSessions | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |

## `onboardingProgress.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| getProgress | query | protectedProcedure | session-tenant scoping |  |  | OK |
| saveProgress | mutation | protectedProcedure | session-tenant scoping |  |  | OK |
| reset | mutation | protectedProcedure | session-tenant scoping |  |  | OK |
| getFunnelAnalytics | query | protectedProcedure | NONE FOUND |  |  | ⚠ UNGUARDED |

## `operatorTemplates.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| list | query | protectedProcedure | NONE FOUND |  |  | ⚠ UNGUARDED |
| getById | query | protectedProcedure | exempt: platform-shared operator templates readable by id; template library is cross-tenant by design |  | yes | OK |
| create | mutation | adminProcedure | adminProcedure (role=admin + Permify) |  |  | OK |
| update | mutation | adminProcedure | adminProcedure (role=admin + Permify) |  | yes | OK |
| toggleActive | mutation | adminProcedure | adminProcedure (role=admin + Permify) |  | yes | OK |
| delete | mutation | adminProcedure | adminProcedure (role=admin + Permify) |  | yes | OK |

## `orchestrator.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| start | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| status | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| history | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |

## `order.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| list | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| stats | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |

## `orderCrud.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| create | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| updateStatus | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| cancel | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| buyerCancel | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| refund | mutation | protectedProcedure | assertMoneyAccess (owner|operator|finance) | yes | yes | OK |
| get | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| listRefunds | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| processRefund | mutation | protectedProcedure | assertMoneyAccess (owner|operator|finance) | yes | yes | OK |
| confirmRefundProcessed | mutation | protectedProcedure | assertMoneyAccess (owner|operator|finance) | yes | yes | OK |
| merge | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| recallCreate | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| recallDispatch | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| recallStats | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |

## `payment.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| list | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| initiate | mutation | protectedProcedure | assertTenantAccess (any membership) | yes | yes | OK |
| confirm | mutation | adminProcedure | adminProcedure (role=admin + Permify) | yes | yes | OK |
| getLedgerBalance | query | protectedProcedure | inline role check | yes | yes | OK |
| reconcileLedger | query | protectedProcedure | assertTenantAccess (any membership) | yes | yes | OK |
| stats | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |

## `paymentGateway.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| configure | mutation | protectedProcedure | inline role check |  | yes | OK |
| getConfig | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| initiate | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| verify | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| listTransactions | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| listProviderAdapters | query | protectedProcedure | NONE FOUND |  |  | ⚠ UNGUARDED |
| getTenantProviders | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| configureProvider | mutation | protectedProcedure | inline role check |  | yes | OK |
| testProvider | mutation | protectedProcedure | assertTenantAccess (any membership) | yes | yes | OK |
| setProviderPriority | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| toggleProvider | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| verifyWebhookSignature | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |

## `payments2.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| list | mutation | analystProcedure | analystProcedure (owner|operator|analyst) | yes | yes | OK |

## `phoneAuth.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| sendOtp | mutation | publicProcedure | publicProcedure (no auth) |  |  | OK |
| verifyOtp | mutation | publicProcedure | publicProcedure (no auth) |  | yes | OK |
| verifyDeviceFactor | mutation | publicProcedure | publicProcedure (no auth) |  | yes | OK |
| listMyDevices | query | protectedProcedure | NONE FOUND |  |  | ⚠ UNGUARDED |
| adminResetDevices | mutation | protectedProcedure | inline role check |  | yes | OK |
| linkPhone | mutation | protectedProcedure | NONE FOUND |  |  | ⚠ UNGUARDED |
| getPhoneStatus | query | protectedProcedure | NONE FOUND |  |  | ⚠ UNGUARDED |
| cleanupExpired | mutation | publicProcedure | publicProcedure (no auth) |  |  | OK |
| unlinkPhone | mutation | protectedProcedure | NONE FOUND |  |  | ⚠ UNGUARDED |
| updateNotifPrefs | mutation | protectedProcedure | NONE FOUND |  |  | ⚠ UNGUARDED |
| stepUpRequest | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |

## `privacy.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| exportMyData | query | protectedProcedure | NONE FOUND | yes |  | ⚠ UNGUARDED |
| requestErasure | mutation | protectedProcedure | NONE FOUND |  |  | ⚠ UNGUARDED |
| listErasureRequests | query | adminProcedure | adminProcedure (role=admin + Permify) |  |  | OK |

## `procurement.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| getMySupplierProfile | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| upsertSupplierProfile | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| listSuppliers | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| getWholesaleCatalog | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| createPo | mutation | protectedProcedure | assertTenantAccess (any membership) | yes | yes | OK |
| listPos | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| getPo | query | protectedProcedure | exempt: object-level check inside getPoForEitherSide (buyer-side or supplier-side access) |  | yes | OK |
| approvePo | mutation | protectedProcedure | assertMoneyAccess (owner|operator|finance) |  | yes | OK |
| rejectPo | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| markFulfilled | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| markPaid | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| cancelDraftPo | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |

## `product.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| list | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| stats | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| create | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| update | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| importCsv | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| validateCsv | query | protectedProcedure | NONE FOUND |  |  | ⚠ UNGUARDED |

## `productImages.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| listClasses | query | publicProcedure | publicProcedure (no auth) |  |  | OK |
| listByClass | query | publicProcedure | publicProcedure (no auth) |  |  | OK |
| uploadImage | mutation | protectedProcedure | getTenantId(ctx) helper |  |  | OK |
| batchUpload | mutation | protectedProcedure | getTenantId(ctx) helper |  |  | OK |
| updateBbox | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| rateImage | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| deleteImage | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| datasetStats | query | publicProcedure | publicProcedure (no auth) |  |  | OK |
| clearClassBboxes | mutation | protectedProcedure | NONE FOUND |  |  | ⚠ UNGUARDED |
| exportManifest | mutation | protectedProcedure | NONE FOUND |  |  | ⚠ UNGUARDED |

## `promos.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| list | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| create | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| update | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| delete | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| validate | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |

## `provisioning.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| getSession | query | protectedProcedure | getTenantId(ctx) helper |  |  | OK |
| initSession | mutation | protectedProcedure | getTenantId(ctx) helper |  |  | OK |
| saveStep | mutation | protectedProcedure | getTenantId(ctx) helper |  |  | OK |
| provisionMedusa | mutation | protectedProcedure | domain guard: assertProvisionAccess( |  |  | OK |
| provisionTwentyCrm | mutation | protectedProcedure | domain guard: assertProvisionAccess( |  |  | OK |
| provisionOdooErp | mutation | protectedProcedure | domain guard: assertProvisionAccess( |  |  | OK |
| provisionChannel | mutation | protectedProcedure | domain guard: assertProvisionAccess( |  |  | OK |
| provisionPayment | mutation | protectedProcedure | domain guard: assertProvisionAccess( |  |  | OK |
| listIntegrations | query | protectedProcedure | getTenantId(ctx) helper |  |  | OK |
| pingIntegration | mutation | protectedProcedure | getTenantId(ctx) helper |  | yes | OK |
| listProvisioningJobs | query | protectedProcedure | getTenantId(ctx) helper |  |  | OK |
| adminListOnboardingStatus | query | adminProcedure | adminProcedure (role=admin + Permify) |  |  | OK |
| getSyncEvents | query | protectedProcedure | getTenantId(ctx) helper |  |  | OK |

## `quickReplyTemplates.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| list | query | protectedProcedure | session-tenant scoping |  |  | OK |
| create | mutation | protectedProcedure | session-tenant scoping |  |  | OK |
| delete | mutation | protectedProcedure | exempt: shared quick-reply template library (tenantId nullable; list is global), cross-tenant by design |  | yes | OK |
| incrementUsage | mutation | protectedProcedure | exempt: shared quick-reply template library (tenantId nullable; list is global), cross-tenant by design |  | yes | OK |
| listCategories | query | protectedProcedure | session-tenant scoping |  |  | OK |

## `receiptScan.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| scanImage | mutation | publicProcedure | publicProcedure (no auth) |  |  | OK |

## `reconciliation.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| simulate | mutation | protectedProcedure | NONE FOUND |  |  | ⚠ UNGUARDED |
| getAuditTrail | query | protectedProcedure | inline role check |  | yes | OK |
| verifyReconciliation | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| listSimulations | query | protectedProcedure | NONE FOUND |  |  | ⚠ UNGUARDED |

## `recurringRules.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| list | query | analystProcedure | analystProcedure (owner|operator|analyst) | yes | yes | OK |
| get | mutation | analystProcedure | analystProcedure (owner|operator|analyst) | yes | yes | OK |

## `report.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| monthlySettlement | query | adminProcedure | adminProcedure (role=admin + Permify) |  |  | OK |

## `revenue.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| summary | query | adminProcedure | adminProcedure (role=admin + Permify) |  |  | OK |
| monthlyTrend | query | adminProcedure | adminProcedure (role=admin + Permify) |  |  | OK |
| tenantBreakdown | query | adminProcedure | adminProcedure (role=admin + Permify) |  |  | OK |
| forecast | query | adminProcedure | adminProcedure (role=admin + Permify) |  |  | OK |
| gmvLeaderboard | query | adminProcedure | adminProcedure (role=admin + Permify) |  |  | OK |
| getForecastAccuracy | query | adminProcedure | adminProcedure (role=admin + Permify) |  |  | OK |
| getConfig | query | adminProcedure | adminProcedure (role=admin + Permify) |  |  | OK |

## `reviews.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| list | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| summary | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| respond | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| moderate | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| submitByToken | mutation | publicProcedure | publicProcedure (no auth) |  | yes | OK |

## `rma.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| list | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| create | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| decide | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| receive | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| refund | mutation | protectedProcedure | assertMoneyAccess (owner|operator|finance) | yes | yes | OK |
| getDisplayFx | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| setDisplayFx | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |

## `savings.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| createCircle | mutation | protectedProcedure | assertTenantAccess (any membership) |  |  | OK |
| listCircles | query | protectedProcedure | assertTenantAccess (any membership) |  |  | OK |
| statement | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| recordContribution | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| markMissed | mutation | protectedProcedure | assertTenantAccess (any membership) |  |  | OK |
| retryPendingPayouts | mutation | protectedProcedure | assertMoneyAccess (owner|operator|finance) |  |  | OK |
| memberToken | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| memberStatement | query | publicProcedure | publicProcedure (no auth) | yes |  | OK |
| upsertProduct | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| listProducts | query | protectedProcedure | assertTenantAccess (any membership) |  |  | OK |
| quote | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| bind | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| fileClaim | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| parametricEvent | mutation | adminProcedure | adminProcedure (role=admin + Permify) |  | yes | OK |
| confirmPayout | mutation | adminProcedure | adminProcedure (role=admin + Permify) |  | yes | OK |
| listPolicies | query | protectedProcedure | assertTenantAccess (any membership) |  |  | OK |
| listClaims | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| createProgram | mutation | protectedProcedure | assertTenantAccess (any membership) |  |  | OK |
| listPrograms | query | protectedProcedure | assertTenantAccess (any membership) |  |  | OK |
| issue | mutation | protectedProcedure | assertTenantAccess (any membership) | yes | yes | OK |
| redeem | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| report | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| reportCsv | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| checkByCode | query | publicProcedure | publicProcedure (no auth) | yes |  | OK |

## `search.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| messages | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| indexMessage | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| orders | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |

## `serviceCommerce.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| listServices | query | publicProcedure | publicProcedure (no auth) |  | yes | OK |
| createService | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| bookAppointment | mutation | publicProcedure | publicProcedure (no auth) |  | yes | OK |
| listAppointments | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| updateAppointmentStatus | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| listDigitalProducts | query | publicProcedure | publicProcedure (no auth) |  | yes | OK |
| purchaseDigitalProduct | mutation | publicProcedure | publicProcedure (no auth) |  | yes | OK |
| createSubscription | mutation | publicProcedure | publicProcedure (no auth) | yes | yes | OK |
| listSubscriptions | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| cancelSubscription | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |

## `shopifyIntegration.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| connect | mutation | operatorProcedure | operatorProcedure (owner|operator) |  | yes | OK |
| callback | mutation | operatorProcedure | operatorProcedure (owner|operator) |  | yes | OK |
| disconnect | mutation | operatorProcedure | operatorProcedure (owner|operator) |  | yes | OK |
| syncNow | mutation | operatorProcedure | operatorProcedure (owner|operator) |  | yes | OK |
| status | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| health | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |

## `sla.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| getConfig | query | protectedProcedure | session-tenant scoping |  |  | OK |
| updateConfig | mutation | protectedProcedure | session-tenant scoping |  |  | OK |
| getPlatformOverview | query | adminProcedure | adminProcedure (role=admin + Permify) | yes |  | OK |
| getEscrowSlaStatus | query | protectedProcedure | session-tenant scoping | yes | yes | OK |

## `slaExtension.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| requestExtension | mutation | protectedProcedure | session-tenant scoping | yes | yes | OK |
| listExtensions | query | protectedProcedure | session-tenant scoping |  | yes | OK |
| getByToken | query | publicProcedure | publicProcedure (no auth) | yes |  | OK |
| respondToExtension | mutation | publicProcedure | publicProcedure (no auth) | yes |  | OK |
| listByEscrow | query | protectedProcedure | assertTenantAccess (any membership) | yes | yes | OK |

## `storefront.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| getBySlug | query | publicProcedure | publicProcedure (no auth) |  |  | OK |
| getSettings | query | protectedProcedure | NONE FOUND |  |  | ⚠ UNGUARDED |
| upsertSettings | mutation | protectedProcedure | NONE FOUND |  |  | ⚠ UNGUARDED |
| setVisibility | mutation | protectedProcedure | NONE FOUND |  |  | ⚠ UNGUARDED |

## `taxStatements.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| listProfiles | mutation | analystProcedure | analystProcedure (owner|operator|analyst) |  | yes | OK |
| annualTotals | mutation | analystProcedure | analystProcedure (owner|operator|analyst) |  | yes | OK |
| listStatements | query | analystProcedure | analystProcedure (owner|operator|analyst) |  | yes | OK |
| supplierInbox | query | analystProcedure | analystProcedure (owner|operator|analyst) |  | yes | OK |
| markViewed | mutation | analystProcedure | analystProcedure (owner|operator|analyst) |  | yes | OK |

## `taxonomy.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| list | query | publicProcedure | publicProcedure (no auth) |  | yes | OK |
| categories | query | publicProcedure | publicProcedure (no auth) |  |  | OK |
| searchHints | query | publicProcedure | publicProcedure (no auth) |  |  | OK |
| addCustom | mutation | protectedProcedure | NONE FOUND |  |  | OK |
| seed | mutation | protectedProcedure | NONE FOUND |  |  | ⚠ UNGUARDED |
| stats | query | publicProcedure | publicProcedure (no auth) |  |  | OK |

## `telemetry.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| getStatus | query | adminProcedure | adminProcedure (role=admin + Permify) |  |  | OK |
| setTenantAllowlist | mutation | adminProcedure | adminProcedure (role=admin + Permify) |  |  | OK |
| tenantClass | query | adminProcedure | adminProcedure (role=admin + Permify) |  | yes | OK |

## `template.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| list | query | protectedProcedure | getTenantId(ctx) helper |  |  | OK |
| get | query | protectedProcedure | getTenantId(ctx) helper |  | yes | OK |
| create | mutation | protectedProcedure | getTenantId(ctx) helper |  |  | OK |
| update | mutation | protectedProcedure | getTenantId(ctx) helper |  | yes | OK |
| delete | mutation | protectedProcedure | getTenantId(ctx) helper |  | yes | OK |
| toggleActive | mutation | protectedProcedure | getTenantId(ctx) helper |  | yes | OK |
| recordUsage | mutation | protectedProcedure | getTenantId(ctx) helper |  | yes | OK |
| preview | query | protectedProcedure | getTenantId(ctx) helper |  | yes | OK |
| submitForApproval | mutation | protectedProcedure | getTenantId(ctx) helper |  | yes | OK |
| updateApprovalStatus | mutation | protectedProcedure | getTenantId(ctx) helper |  | yes | OK |
| getApprovalHistoryReal | query | protectedProcedure | getTenantId(ctx) helper |  | yes | OK |
| getApprovalHistory | query | protectedProcedure | getTenantId(ctx) helper |  | yes | OK |

## `templateVersions.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| list | query | protectedProcedure | domain guard: assertTemplateAccess( |  | yes | OK |
| create | mutation | protectedProcedure | domain guard: assertTemplateAccess( |  | yes | OK |
| publish | mutation | protectedProcedure | domain guard: assertTemplateAccess( |  | yes | OK |
| revert | mutation | protectedProcedure | domain guard: assertTemplateAccess( |  | yes | OK |
| archive | mutation | protectedProcedure | domain guard: assertTemplateAccess( |  | yes | OK |

## `temporal.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| startWorkflow | mutation | adminProcedure | adminProcedure (role=admin + Permify) |  | yes | OK |
| recordRun | mutation | internalProcedure | internalProcedure (shared-secret) |  | yes | OK |
| updateStatus | mutation | internalProcedure | internalProcedure (shared-secret) |  | yes | OK |
| getStatus | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| listRuns | query | adminProcedure | adminProcedure (role=admin + Permify) |  | yes | OK |
| getRun | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| health | query | publicProcedure | publicProcedure (no auth) |  |  | OK |
| startOnboarding | mutation | adminProcedure | adminProcedure (role=admin + Permify) |  | yes | OK |
| startOrderFulfillment | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| startBroadcast | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| startInventorySync | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |

## `tenant.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| tenantTheme | query | publicProcedure | publicProcedure (no auth) |  |  | OK |
| myTenant | query | protectedProcedure | session-tenant scoping |  |  | OK |
| list | query | adminProcedure | adminProcedure (role=admin + Permify) |  |  | OK |
| stats | query | adminProcedure | adminProcedure (role=admin + Permify) |  |  | OK |
| get | query | adminProcedure | adminProcedure (role=admin + Permify) |  | yes | OK |
| create | mutation | adminProcedure | adminProcedure (role=admin + Permify) |  |  | OK |
| getWhatsAppConfig | query | operatorProcedure | operatorProcedure (owner|operator) |  | yes | OK |
| updateWhatsAppConfig | mutation | operatorProcedure | operatorProcedure (owner|operator) |  | yes | OK |
| getTelegramConfig | query | operatorProcedure | operatorProcedure (owner|operator) |  | yes | OK |
| updateTelegramConfig | mutation | operatorProcedure | operatorProcedure (owner|operator) |  | yes | OK |
| update | mutation | adminProcedure | adminProcedure (role=admin + Permify) |  | yes | OK |

## `tenantAnalytics.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| getOverview | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| getGmvTimeSeries | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| getTopProducts | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| getRetention | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| getPaymentBreakdown | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |

## `tenantConfig.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| getCrmConfig | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| setPipelineStages | mutation | protectedProcedure | assertTenantAccess (any membership) |  |  | OK |
| addCustomField | mutation | protectedProcedure | assertTenantAccess (any membership) |  |  | OK |
| updateCustomField | mutation | protectedProcedure | assertTenantAccess (any membership) |  |  | OK |
| removeCustomField | mutation | protectedProcedure | assertTenantAccess (any membership) |  |  | OK |
| getInventoryConfig | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| setInventoryConfig | mutation | protectedProcedure | assertTenantAccess (any membership) |  |  | OK |
| getCommerceConfig | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| setCommerceConfig | mutation | protectedProcedure | assertTenantAccess (any membership) |  |  | OK |
| getBrandingConfig | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| setBrandingConfig | mutation | protectedProcedure | assertTenantAccess (any membership) |  |  | OK |
| uploadLogo | mutation | protectedProcedure | assertTenantAccess (any membership) |  |  | OK |
| getDomains | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| setDomains | mutation | protectedProcedure | assertTenantAccess (any membership) |  |  | OK |
| getWaMenuConfig | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| setWaMenuConfig | mutation | protectedProcedure | assertTenantAccess (any membership) |  |  | OK |
| addWaMenuCustomItem | mutation | protectedProcedure | assertTenantAccess (any membership) |  |  | OK |
| updateWaMenuItem | mutation | protectedProcedure | assertTenantAccess (any membership) |  |  | OK |
| removeWaMenuCustomItem | mutation | protectedProcedure | assertTenantAccess (any membership) |  |  | OK |
| reorderWaMenuUseCases | mutation | protectedProcedure | assertTenantAccess (any membership) |  |  | OK |
| getFaq | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| setFaq | mutation | protectedProcedure | assertTenantAccess (any membership) |  |  | OK |
| previewWaMenu | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| getMetaCatalog | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| setMetaCatalog | mutation | protectedProcedure | assertTenantAccess (any membership) |  |  | OK |
| syncMetaCatalogNow | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| metaCatalogSyncStatus | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| getVisualSearch | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| setVisualSearch | mutation | protectedProcedure | assertTenantAccess (any membership) |  |  | OK |

## `tenantInvite.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| create | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| validate | mutation | publicProcedure | publicProcedure (no auth) |  |  | OK |
| resend | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |

## `tracking.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| getByToken | query | publicProcedure | publicProcedure (no auth) |  |  | OK |

## `tradeCredit.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| createAccount | mutation | protectedProcedure | assertMoneyAccess (owner|operator|finance) |  | yes | OK |
| updateAccount | mutation | protectedProcedure | assertMoneyAccess (owner|operator|finance) | yes | yes | OK |
| setAccountStatus | mutation | protectedProcedure | assertMoneyAccess (owner|operator|finance) | yes | yes | OK |
| approveAccount | mutation | protectedProcedure | assertMoneyAccess (owner|operator|finance) | yes | yes | OK |
| listAccounts | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| accountLedger | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| suggestLimit | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| trainPdModel | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| pdModelStatus | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| banditStatus | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| banditReplay | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| recordRepayment | mutation | protectedProcedure | assertMoneyAccess (owner|operator|finance) | yes | yes | OK |
| requestAccount | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| myAccounts | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| myAccount | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| myLedger | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| requestLimitIncrease | mutation | protectedProcedure | assertTenantAccess (any membership) | yes | yes | OK |
| requestMandate | mutation | protectedProcedure | assertTenantAccess (any membership) | yes | yes | OK |
| confirmMandate | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| revokeMandate | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| initiateRepayment | mutation | protectedProcedure | assertTenantAccess (any membership) | yes | yes | OK |
| retrySettlement | mutation | adminProcedure | adminProcedure (role=admin + Permify) | yes | yes | OK |
| reconcileMandateCharges | mutation | adminProcedure | adminProcedure (role=admin + Permify) |  |  | OK |

## `twenty.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| getConfig | query | protectedProcedure | getTenantId(ctx) helper |  |  | OK |
| saveConfig | mutation | protectedProcedure | getTenantId(ctx) helper |  | yes | OK |
| testConnection | mutation | protectedProcedure | getTenantId(ctx) helper |  |  | OK |
| configure | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| syncContacts | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| syncAll | mutation | protectedProcedure | getTenantId(ctx) helper |  |  | OK |
| listContacts | query | protectedProcedure | getTenantId(ctx) helper |  |  | OK |
| listDeals | query | protectedProcedure | getTenantId(ctx) helper |  |  | OK |
| sendWhatsApp | mutation | protectedProcedure | getTenantId(ctx) helper |  | yes | OK |

## `ucDocs.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| listCustomerStatements | mutation | analystProcedure | analystProcedure (owner|operator|analyst) |  | yes | OK |
| listProformas | mutation | analystProcedure | analystProcedure (owner|operator|analyst) |  | yes | OK |
| listAgents | mutation | analystProcedure | analystProcedure (owner|operator|analyst) |  | yes | OK |
| listAgentCommissions | mutation | analystProcedure | analystProcedure (owner|operator|analyst) |  | yes | OK |
| listCommissionStatements | query | analystProcedure | analystProcedure (owner|operator|analyst) |  | yes | OK |
| quoteForBuyer | query | analystProcedure | analystProcedure (owner|operator|analyst) |  | yes | OK |

## `ucMoney.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| createAuction | mutation | protectedProcedure | assertMoneyAccess (owner|operator|finance) |  | yes | OK |
| placeBid | mutation | protectedProcedure | tenantCtx(ctx) helper (wraps assertTenantAccess) | yes | yes | OK |
| sweepAuctions | mutation | protectedProcedure | assertMoneyAccess (owner|operator|finance) |  | yes | OK |
| setTip | mutation | protectedProcedure | tenantCtx(ctx) helper (wraps assertTenantAccess) |  | yes | OK |
| createDonation | mutation | protectedProcedure | tenantCtx(ctx) helper (wraps assertTenantAccess) | yes | yes | OK |
| amendOrder | mutation | protectedProcedure | assertMoneyAccess (owner|operator|finance) |  | yes | OK |

## `vendorBills.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| list | query | analystProcedure | analystProcedure (owner|operator|analyst) |  | yes | OK |
| get | mutation | analystProcedure | analystProcedure (owner|operator|analyst) | yes | yes | OK |
| installmentPlans | query | analystProcedure | analystProcedure (owner|operator|analyst) |  | yes | OK |
| payOverTimeEligibility | mutation | analystProcedure | analystProcedure (owner|operator|analyst) |  | yes | OK |

## `viCorrections.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| listBySession | query | protectedProcedure | NONE FOUND |  | yes | OK |
| listRecent | query | protectedProcedure | NONE FOUND |  |  | OK |
| saveCorrection | mutation | protectedProcedure | NONE FOUND |  | yes | OK |
| bulkSaveCorrections | mutation | protectedProcedure | NONE FOUND |  | yes | OK |
| exportToLabelStudio | mutation | protectedProcedure | NONE FOUND |  |  | OK |
| stats | query | protectedProcedure | NONE FOUND |  |  | OK |

## `visualInventory.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| analyseImage | mutation | protectedProcedure | getTenantId(ctx) helper |  |  | OK |
| getSession | query | protectedProcedure | getTenantId(ctx) helper |  | yes | OK |
| listSessions | query | protectedProcedure | getTenantId(ctx) helper |  |  | OK |
| applyToInventory | mutation | protectedProcedure | getTenantId(ctx) helper |  | yes | OK |
| scanStats | query | protectedProcedure | NONE FOUND |  |  | OK |
| getMappings | query | protectedProcedure | getTenantId(ctx) helper |  |  | OK |
| getOllamaModels | query | protectedProcedure | NONE FOUND |  |  | ⚠ UNGUARDED |

## `w44SubscriptionsPins.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| createPlan | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| archivePlan | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| listPlans | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| uploadBatch | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| stock | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |

## `waTemplates.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| list | query | protectedProcedure | assertTenantAccess (any membership) |  |  | OK |
| create | mutation | protectedProcedure | assertTenantAccess (any membership) |  |  | OK |
| listLibrary | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| submit | mutation | operatorProcedure | operatorProcedure (owner|operator) |  |  | OK |
| syncStatus | mutation | operatorProcedure | operatorProcedure (owner|operator) |  | yes | OK |
| statusSync | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |

## `webhookDlq.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| listEvents | query | adminProcedure | adminProcedure (role=admin + Permify) |  |  | OK |
| retryEvent | mutation | adminProcedure | adminProcedure (role=admin + Permify) |  | yes | OK |
| dismissEvent | mutation | adminProcedure | adminProcedure (role=admin + Permify) |  | yes | OK |
| stats | query | adminProcedure | adminProcedure (role=admin + Permify) |  |  | OK |

## `whatsappMedia.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| upload | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| list | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| getDownloadUrl | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| setUssdMode | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| setSmsFailover | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |

## `whatsappNotifications.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| sendOrderNotif | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| getOrderNotifStatus | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| getNotificationHistory | query | protectedProcedure | NONE FOUND |  |  | ⚠ UNGUARDED |
| resendNotification | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| getCustomerReplies | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| markReplyRead | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| markReplyUnread | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| getUnreadReplyCount | query | protectedProcedure | session-tenant scoping |  |  | OK |
| getBulkUnreadReplyCounts | query | protectedProcedure | NONE FOUND |  |  | ⚠ UNGUARDED |
| sendAdminReply | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| suggestReply | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| sendAttachment | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |

## `wholesale.ts`

| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |
|---|---|---|---|---|---|---|
| createListing | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| updateListing | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| listMyListings | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| browseMarketplace | query | publicProcedure | publicProcedure (no auth) |  | yes | OK |
| getListingPublic | query | publicProcedure | publicProcedure (no auth) |  | yes | OK |
| quote | query | publicProcedure | publicProcedure (no auth) |  | yes | OK |
| placeOrder | mutation | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| placeOrderByPhone | mutation | publicProcedure | publicProcedure (no auth) |  | yes | OK |
| myOrderByPhone | query | publicProcedure | publicProcedure (no auth) |  | yes | OK |
| listOrders | query | protectedProcedure | assertTenantAccess (any membership) |  | yes | OK |
| updateOrderStatus | mutation | protectedProcedure | assertMoneyAccess (owner|operator|finance) |  | yes | OK |
| creditScorePreview | mutation | protectedProcedure | assertMoneyAccess (owner|operator|finance) |  | yes | OK |
| earlyPayPreview | mutation | protectedProcedure | assertMoneyAccess (owner|operator|finance) | yes | yes | OK |

