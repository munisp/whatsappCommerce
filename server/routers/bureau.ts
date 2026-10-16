// === W56 credit ===
/**
 * bureau router — tenant-scoped bureau pulls (consent-first), pull history,
 * consent artefacts and repayment report-back status over
 * services/bureau.ts (W56). Pulls are fail-open on provider outages but
 * fail-closed on missing consent.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, router, assertTenantAccess } from "../_core/trpc";
import { getDb } from "../db";
import {
  getLiveBureauConsent,
  listBureauPulls,
  listReportOutbox,
  pullCreditReport,
  recordBureauConsent,
  reportRepayment,
  revokeBureauConsent,
  runBureauReportSweep,
  BUREAU_CONSENT_VERSION,
} from "../services/bureau";
import { BUREAU_CONSENT_TEXT, SUPPORTED_LOCALES, type Locale } from "../services/i18n";

const subjectType = z.enum(["buyer", "merchant"]);
const channel = z.enum(["whatsapp", "telegram", "portal", "api"]);

export const bureauRouter = router({
  /** The exact consent copy (×8 locales) + version for the consent UI. */
  consentText: protectedProcedure
    .input(z.object({ locale: z.string().optional() }))
    .query(({ input }) => {
      const locale = (SUPPORTED_LOCALES as readonly string[]).includes(input.locale ?? "")
        ? (input.locale as Locale)
        : "en";
      return { version: BUREAU_CONSENT_VERSION, locale, text: BUREAU_CONSENT_TEXT[locale] };
    }),

  /** Record consent for a subject (BEFORE any pull). Portal channel. */
  recordConsent: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      subjectType,
      subjectId: z.string().min(1),
      channel: channel.default("portal"),
      locale: z.string().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const locale = (SUPPORTED_LOCALES as readonly string[]).includes(input.locale ?? "")
        ? (input.locale as Locale)
        : "en";
      return recordBureauConsent(db, { ...input, locale });
    }),

  /** Revoke the subject's consent (NDPR data-subject right). */
  revokeConsent: protectedProcedure
    .input(z.object({ tenantId: z.string(), subjectType, subjectId: z.string().min(1) }))
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      return { revoked: await revokeBureauConsent(db, input.tenantId, input.subjectType, input.subjectId) };
    }),

  /** Consent status for a subject. */
  consentStatus: protectedProcedure
    .input(z.object({ tenantId: z.string(), subjectType, subjectId: z.string().min(1) }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const live = await getLiveBureauConsent(db, input.tenantId, input.subjectType, input.subjectId);
      return { consented: live != null, consent: live };
    }),

  /** Pull a credit report. Requires a live consent artefact. */
  pull: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      subjectType,
      subjectId: z.string().min(1),
      phone: z.string().optional(),
      bvn: z.string().optional(),
      businessName: z.string().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const outcome = await pullCreditReport(db, {
        tenantId: input.tenantId,
        subject: {
          subjectType: input.subjectType,
          subjectId: input.subjectId,
          phone: input.phone,
          bvn: input.bvn,
          businessName: input.businessName,
        },
      });
      if (outcome.error === "consent_required") {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Bureau consent is required before a pull" });
      }
      return outcome;
    }),

  /** Pull history for a subject (newest first). */
  history: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      subjectType,
      subjectId: z.string().min(1),
      limit: z.number().int().min(1).max(100).optional(),
    }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      return listBureauPulls(db, input.tenantId, input.subjectType, input.subjectId, input.limit);
    }),

  /** Enqueue repayment-performance events for bureau report-back. */
  reportRepayment: protectedProcedure
    .input(z.object({
      events: z.array(z.object({
        tenantId: z.string(),
        subjectType,
        subjectId: z.string().min(1),
        eventType: z.enum(["paid_on_time", "late", "default", "settled"]),
        amountCents: z.number().int().min(0).optional(),
        ref: z.string().min(1).max(120),
      })).min(1).max(100),
    }))
    .mutation(async ({ input, ctx }) => {
      for (const e of input.events) assertTenantAccess(ctx.user, e.tenantId);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      return { enqueued: await reportRepayment(db, input.events) };
    }),

  /** Report-back outbox status for the tenant. */
  reportStatus: protectedProcedure
    .input(z.object({ tenantId: z.string(), limit: z.number().int().min(1).max(200).optional() }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      return listReportOutbox(db, input.tenantId, input.limit);
    }),

  /** Tenant-scoped report-back sweep (same core as the cron route). */
  sweepNow: protectedProcedure
    .input(z.object({ tenantId: z.string(), limit: z.number().int().min(1).max(200).optional() }))
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      return runBureauReportSweep(db, { tenantId: input.tenantId, limit: input.limit });
    }),
});
