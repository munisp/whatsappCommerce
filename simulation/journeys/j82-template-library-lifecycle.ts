/**
 * J82 — WhatsApp template pre-approval library lifecycle (W16 F9).
 *
 * NOTE (W16): this journey drives the library/preApproval services directly;
 * Meta Graph traffic is the metaMock message_templates seam (not WhatsApp
 * message sends), so transcripts/J82.json is intentionally a header-only
 * stub (messages: []). Same convention as J75–J77.
 *
 * Flow:
 *   1. validateLibrary() integrity: 10 templates × 5 locales (en/ha/yo/ig/pcm),
 *      Meta-safe names, contiguous placeholders, opt-out/promo copy rules.
 *   2. Submit two templates (order_confirmation/en UTILITY + weekly_promo/pcm
 *      MARKETING) → POSTed to the WABA, tracked as 'submitted'.
 *   3. Double-submit is idempotent (no second Meta call); unknown key and
 *      unsupported language fail with structured errors.
 *   4. Status sync: PENDING stays submitted; Meta flips one APPROVED and one
 *      REJECTED (rejected_reason captured verbatim).
 *   5. Re-submitting the rejected pair creates a fresh submission (new Meta
 *      call); the approved pair stays idempotent.
 */
import { eq } from "drizzle-orm";
import { assert, TENANT_ID, WABA_ID, type World } from "../world";
import type { Journey } from "../runner";
import { meta, setTemplates } from "../metaMock";

export const journey: Journey = {
  id: "J82",
  name: "template library lifecycle",
  feature: "validate → submit ×2 → sync approved/rejected-with-reason → resubmit → idempotent double-submit",
  async run(world) {
    const schema = await import("../../drizzle/schema");
    const lib = await import("../../server/services/waTemplates/library");
    const pre = await import("../../server/services/waTemplates/preApproval");

    const seedTemplates = (meta.templates.get(WABA_ID) ?? []).map((t) => ({ ...t }));
    const submissions = async () =>
      pre.parseSubmissionState(await world.tenantSettings()).submissions;
    const tplCalls = () =>
      world.outbound.all().filter((c) => c.url.includes(`/${WABA_ID}/message_templates`));
    const tplPosts = () => tplCalls().filter((c) => c.method === "POST");

    try {
      // ── 1. Library integrity ─────────────────────────────────────────────
      const issues = lib.validateLibrary();
      assert(issues.length === 0, `library validates clean (got ${JSON.stringify(issues).slice(0, 300)})`);
      assert(lib.WA_TEMPLATE_LIBRARY.length === 10, "10 curated templates");
      for (const entry of lib.WA_TEMPLATE_LIBRARY) {
        for (const locale of lib.WA_TEMPLATE_LOCALES) {
          assert(typeof entry.bodies[locale] === "string" && entry.bodies[locale].length > 10,
            `${entry.key}/${locale} body present`);
        }
      }
      assert(lib.getLibraryEntry("order_confirmation")?.category === "UTILITY", "lookup by key");

      // ── 2. Submit two ────────────────────────────────────────────────────
      const postsBefore = tplPosts().length;
      const s1 = await pre.submitTemplate(world.db, TENANT_ID, "order_confirmation", "en");
      assert(s1.ok === true && s1.idempotent === false, "first submit succeeds");
      assert(s1.submission.status === "submitted" && s1.submission.metaTemplateId.length > 0, "tracked as submitted");
      const s2 = await pre.submitTemplate(world.db, TENANT_ID, "weekly_promo", "pcm");
      assert(s2.ok === true && s2.submission.category === "MARKETING", "second submit succeeds");
      assert(tplPosts().length === postsBefore + 2, "exactly 2 Meta create calls");
      const postedBodies = tplPosts().slice(postsBefore).map((c) => c.body);
      assert(
        postedBodies.every((b: any) => b?.components?.[0]?.example?.body_text?.[0]?.length === b?.components?.[0]?.text?.match(/\{\{\d+\}\}/g)?.length),
        "positional placeholders submitted with matching samples",
      );
      assert((await submissions()).length === 2, "both submissions persisted in settings.waTemplateLibrary");

      // ── 3. Double-submit idempotent + structured failures ───────────────
      const dup = await pre.submitTemplate(world.db, TENANT_ID, "order_confirmation", "en");
      assert(dup.ok === true && dup.idempotent === true, "double-submit short-circuits");
      assert(tplPosts().length === postsBefore + 2, "idempotent re-submit made NO Meta call");
      const badKey = await pre.submitTemplate(world.db, TENANT_ID, "no_such_template", "en");
      assert(badKey.ok === false && badKey.error === "unknown_template", "unknown key refused");
      const badLang = await pre.submitTemplate(world.db, TENANT_ID, "order_confirmation", "fr");
      assert(badLang.ok === false && badLang.error === "unsupported_language", "unsupported language refused");

      // ── 4. Status sync: pending → approved / rejected-with-reason ───────
      const sync0 = await pre.syncTemplateStatuses(world.db, TENANT_ID);
      assert(sync0.updated === 0, "PENDING remote rows keep local 'submitted'");

      const remote = (meta.templates.get(WABA_ID) ?? []).map((t: any) => {
        if (t.name === "w16_order_confirmation" && t.language === "en") return { ...t, status: "APPROVED" };
        if (t.name === "w16_weekly_promo" && t.language === "pcm") {
          return { ...t, status: "REJECTED", rejected_reason: "PROMOTIONAL_CONTENT: misleading offer" };
        }
        return t;
      });
      setTemplates(WABA_ID, remote);
      const sync1 = await pre.syncTemplateStatuses(world.db, TENANT_ID);
      assert(sync1.updated === 2, `both decisions applied (got ${sync1.updated})`);
      const after = await submissions();
      const oc = after.find((s) => s.templateKey === "order_confirmation" && s.language === "en");
      const wp = after.find((s) => s.templateKey === "weekly_promo" && s.language === "pcm");
      assert(oc?.status === "approved" && oc.rejectionReason === null, "approved via sync");
      assert(wp?.status === "rejected" && wp.rejectionReason === "PROMOTIONAL_CONTENT: misleading offer",
        "rejected WITH Meta's reason captured");
      const sync2 = await pre.syncTemplateStatuses(world.db, TENANT_ID);
      assert(sync2.updated === 0, "status sync is itself idempotent");

      // ── 5. Resubmit rejected (fresh Meta call); approved stays idempotent
      const resub = await pre.submitTemplate(world.db, TENANT_ID, "weekly_promo", "pcm");
      assert(resub.ok === true && resub.idempotent === false, "rejected pair resubmits");
      assert(resub.submission.status === "submitted" && resub.submission.rejectionReason === null, "fresh submission tracked");
      assert(tplPosts().length === postsBefore + 3, "resubmit made exactly one new Meta call");
      const stillApproved = await pre.submitTemplate(world.db, TENANT_ID, "order_confirmation", "en");
      assert(stillApproved.ok === true && stillApproved.idempotent === true, "approved pair never resubmits");
      assert(tplPosts().length === postsBefore + 3, "approved idempotency made no Meta call");
      const finalSubs = await submissions();
      assert(
        finalSubs.filter((s) => s.templateKey === "weekly_promo" && s.language === "pcm").length === 1,
        "resubmission replaces, never duplicates",
      );
    } finally {
      setTemplates(WABA_ID, seedTemplates);
      const s = { ...(await world.tenantSettings()) } as Record<string, any>;
      if ("waTemplateLibrary" in s) {
        delete s.waTemplateLibrary;
        await world.db
          .update(schema.tenants)
          .set({ settings: s, updatedAt: new Date() })
          .where(eq(schema.tenants.id, TENANT_ID));
      }
    }
  },
};
