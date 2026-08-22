/**
 * W27 — WhatsApp flows for the B2B wholesale marketplace + group buying.
 *
 * PURE command parsing (unit-testable, no DB) + thin handlers that call the
 * wholesaleCatalog / groupBuy services. Wired into the inbound NLP pipeline
 * as a deterministic pre-LLM section (see routers/nlp.ts §3f) following the
 * discoveryMenu.ts / locationInbound.ts exemplars.
 *
 * Commands (case-insensitive):
 *   "wholesale [query]"        → browse/search active marketplace listings
 *   "buy <n> <qty>"            → order listing #n from the last menu, qty units
 *   "deals"                    → list open group deals with progress bars
 *   "join <ref> <qty>"         → join deal <ref> (8-char prefix) with qty
 *   "deal <ref>"               → live progress for deal <ref>
 */
import { eq, sql } from "drizzle-orm";
import { wholesaleListings, groupDeals } from "../../drizzle/schema";
import type { DbHandle } from "./tradeCredit/accounts";
import {
  searchWholesaleListingsTx,
  placeWholesaleOrderTx,
  formatListingForWhatsApp,
  formatMajor,
} from "./wholesaleCatalog";
import {
  joinGroupDealTx,
  getGroupDealTx,
  getGroupDealProgressTx,
  listGroupDealsTx,
  formatDealForWhatsApp,
} from "./groupBuy";

// ── Pure parsing ────────────────────────────────────────────────────────────
export type WholesaleCommand =
  | { kind: "browse"; query?: string }
  | { kind: "buy"; index: number; quantity: number }
  | { kind: "deals" }
  | { kind: "join"; dealRef: string; quantity: number }
  | { kind: "dealProgress"; dealRef: string };

const REF_RE = /^[a-z0-9-]{4,36}$/i;

/** Parse an inbound WhatsApp message; null when not a wholesale/group command. */
export function parseWholesaleCommand(text: string): WholesaleCommand | null {
  const t = text.trim();
  const lower = t.toLowerCase();

  if (lower === "deals" || lower === "group deals" || lower === "group buy") {
    return { kind: "deals" };
  }

  let m = lower.match(/^wholesale(?:\s+([\s\S]*))?$/);
  if (m) {
    const query = (m[1] ?? "").trim();
    return { kind: "browse", ...(query ? { query } : {}) };
  }

  m = lower.match(/^buy\s+(\d{1,3})\s+(?:x\s*)?(\d{1,7})$/);
  if (m) {
    return { kind: "buy", index: parseInt(m[1], 10), quantity: parseInt(m[2], 10) };
  }

  m = lower.match(/^join\s+([a-z0-9-]{4,36})\s+(?:x\s*)?(\d{1,7})$/i);
  if (m && REF_RE.test(m[1])) {
    return { kind: "join", dealRef: m[1].toLowerCase(), quantity: parseInt(m[2], 10) };
  }

  m = lower.match(/^deal\s+([a-z0-9-]{4,36})$/i);
  if (m && REF_RE.test(m[1])) {
    return { kind: "dealProgress", dealRef: m[1].toLowerCase() };
  }

  return null;
}

// ── Resolution helpers ─────────────────────────────────────────────────────
/** Resolve an 8+ char id prefix to a full wholesale listing id (active only). */
export async function resolveListingByPrefix(db: DbHandle, prefix: string): Promise<string | null> {
  const rows = await db
    .select({ id: wholesaleListings.id })
    .from(wholesaleListings)
    .where(sql`${wholesaleListings.id}::text LIKE ${prefix + "%"}`)
    .limit(2);
  return rows.length === 1 ? rows[0].id : null;
}

/** Resolve an 8+ char id prefix to a full group deal id. */
export async function resolveDealByPrefix(db: DbHandle, prefix: string): Promise<string | null> {
  const rows = await db
    .select({ id: groupDeals.id })
    .from(groupDeals)
    .where(sql`${groupDeals.id}::text LIKE ${prefix + "%"}`)
    .limit(2);
  return rows.length === 1 ? rows[0].id : null;
}

// ── Handlers ────────────────────────────────────────────────────────────────
export interface WholesaleSessionCtx {
  lastWholesaleListingIds?: string[];
  [k: string]: unknown;
}

export interface CommandResult {
  reply: string;
  intent: string;
  /** Context patch to persist on the NLP session (listing menu memory). */
  ctxPatch?: Record<string, unknown>;
}

export async function handleWholesaleCommand(
  db: DbHandle,
  cmd: WholesaleCommand,
  args: { waPhoneNumber: string; sessionCtx: WholesaleSessionCtx },
): Promise<CommandResult> {
  switch (cmd.kind) {
    case "browse": {
      const rows = await searchWholesaleListingsTx(db, { query: cmd.query, limit: 5 });
      if (rows.length === 0) {
        return {
          reply: "No wholesale listings match right now. Try *wholesale* to see everything available in bulk.",
          intent: "browse_wholesale",
        };
      }
      const lines = rows.map((r, n) => formatListingForWhatsApp(r.listing, r.tiers, n));
      return {
        reply: [
          `🏪 *Wholesale marketplace*${cmd.query ? ` — “${cmd.query}”` : ""}:`,
          ...lines,
          "",
          "Reply *buy <#> <qty>* to order (e.g. buy 1 100).",
        ].join("\n"),
        intent: "browse_wholesale",
        ctxPatch: { lastWholesaleListingIds: rows.map((r) => r.listing.id) },
      };
    }

    case "buy": {
      const ids = Array.isArray(args.sessionCtx.lastWholesaleListingIds)
        ? args.sessionCtx.lastWholesaleListingIds
        : [];
      const listingId = ids[cmd.index - 1];
      if (!listingId) {
        return {
          reply: "I don't have that listing number — send *wholesale* first to browse, then reply *buy <#> <qty>*.",
          intent: "browse_wholesale",
        };
      }
      const r = await placeWholesaleOrderTx(db, {
        listingId,
        quantity: cmd.quantity,
        buyerPhone: args.waPhoneNumber,
        paymentMode: "pay_now",
      });
      if (!r.ok) {
        const msg =
          r.reason === "below_moq"
            ? "That quantity is below the minimum order quantity (MOQ) — check the listing and try a larger qty."
            : r.reason === "no_tier"
              ? "No price tier covers that quantity — check the listing tiers."
              : "Sorry, that listing isn't available anymore.";
        return { reply: msg, intent: "browse_wholesale" };
      }
      return {
        reply: [
          `✅ Wholesale order placed: ${r.order.quantity} units × ${formatMajor(r.order.unitPriceCents, r.order.currency)} = *${formatMajor(r.order.totalCents, r.order.currency)}*`,
          `Order ref: ${r.order.id.slice(0, 8)}. The wholesaler will confirm and arrange payment/fulfillment.`,
        ].join("\n"),
        intent: "browse_wholesale",
      };
    }

    case "deals": {
      const deals = await listGroupDealsTx(db, { status: "open", limit: 5 });
      if (deals.length === 0) {
        return { reply: "No group deals are open right now — check back soon for bulk discounts!", intent: "join_group_deal" };
      }
      const lines: string[] = ["🤝 *Open group deals*:"];
      for (const d of deals) {
        const p = (await getGroupDealProgressTx(db, d.id))!;
        lines.push(formatDealForWhatsApp(p, d.title, d.unitPriceCents, d.currency));
        lines.push(`Join: *join ${d.id.slice(0, 8)} <qty>*`);
        lines.push("");
      }
      return { reply: lines.join("\n").trim(), intent: "join_group_deal" };
    }

    case "join": {
      const dealId = await resolveDealByPrefix(db, cmd.dealRef);
      if (!dealId) {
        return { reply: "I couldn't find that deal — send *deals* to see what's open.", intent: "join_group_deal" };
      }
      const r = await joinGroupDealTx(db, {
        dealId,
        customerPhone: args.waPhoneNumber,
        quantity: cmd.quantity,
      });
      if (!r.ok) {
        const msg =
          r.reason === "deadline_passed"
            ? "⌛ That deal's deadline has passed — your payment was not taken."
            : r.reason === "deal_not_open"
              ? "That deal is no longer open."
              : "Invalid quantity — try a positive whole number.";
        return { reply: msg, intent: "join_group_deal" };
      }
      const progress = r.progress;
      const dealRow = await getGroupDealTx(db, dealId);
      const head = r.alreadyJoined
        ? "You're already in this deal — here's the latest:"
        : `✅ You're in! ${r.participant.quantity} unit(s) held at ${formatMajor(r.participant.amountCents, r.participant.currency)} total. Payment is only captured if the deal unlocks.`;
      return {
        reply: [
          head,
          dealRow ? formatDealForWhatsApp(progress, dealRow.title, dealRow.unitPriceCents, dealRow.currency) : "",
        ].filter(Boolean).join("\n"),
        intent: "join_group_deal",
      };
    }

    case "dealProgress": {
      const dealId = await resolveDealByPrefix(db, cmd.dealRef);
      if (!dealId) {
        return { reply: "I couldn't find that deal — send *deals* to see what's open.", intent: "join_group_deal" };
      }
      const progress = await getGroupDealProgressTx(db, dealId);
      const dealRow = await getGroupDealTx(db, dealId);
      if (!progress || !dealRow) {
        return { reply: "I couldn't find that deal — send *deals* to see what's open.", intent: "join_group_deal" };
      }
      return {
        reply: formatDealForWhatsApp(progress, dealRow.title, dealRow.unitPriceCents, dealRow.currency),
        intent: "join_group_deal",
      };
    }
  }
}
