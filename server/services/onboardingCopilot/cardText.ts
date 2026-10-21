/**
 * cardText.ts — what a proposal card says, in words a shop owner reads on WhatsApp or Telegram.
 *
 * A card used to be its summary followed by the raw payload as JSON (a base64 logo included). The web copilot draws
 * its own cards from the payload (client/src/lib/copilotLogic.ts), so this text is what the chat channels show: the
 * summary, then the few things the owner is actually deciding — the greeting and the options customers see, the
 * colours and tagline, the integrations offered (never connected until they approve and add their own keys).
 */
import type { IntakeFacts, Proposal } from "./session";
import { DEFAULT_WA_MENU } from "../../../shared/waMenu";

const USE_CASE_LABELS: Record<string, string> = Object.fromEntries(DEFAULT_WA_MENU.useCases.map((u) => [u.id, u.label]));

/** A use-case id as customers see it ("track" → "Track my order"). */
export function useCaseLabel(id: string): string {
  return USE_CASE_LABELS[id] ?? id;
}

const PROVIDER_LABELS: Record<string, string> = {
  medusa: "Medusa (product catalogue)",
  odoo: "Odoo (stock and purchasing)",
  twenty: "Twenty (customer CRM)",
};

const rec = (v: unknown): Record<string, any> => (v && typeof v === "object" ? (v as Record<string, any>) : {});
const list = (v: unknown): any[] => (Array.isArray(v) ? v : []);

/** The card body for a proposal: its summary and a readable account of what it sets up. No JSON. */
export function proposalCardText(p: Proposal, facts: IntakeFacts = {}): string {
  const payload = rec(p.payload);
  const name = String(facts.businessName ?? "").trim() || "your shop";
  const lines: string[] = [];

  switch (p.kind) {
    case "waMenu": {
      const greeting = String(payload.greeting ?? "").replace(/\{businessName\}/g, name).trim();
      const options = list(payload.useCases)
        .filter((u) => u && u.enabled !== false)
        .sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0))
        .map((u) => String(u.label || useCaseLabel(String(u.id ?? ""))))
        .concat(list(payload.customItems).map((c) => String(c?.label ?? c?.title ?? "")).filter(Boolean));
      if (greeting) lines.push(`Greeting: “${greeting}”`);
      if (options.length) lines.push("Customers can pick:", ...options.map((o) => `• ${o}`));
      break;
    }
    case "useCases": {
      const ranked = list(payload.ranked).map((id) => useCaseLabel(String(id)));
      if (ranked.length) lines.push("In this order:", ...ranked.slice(0, 5).map((l, i) => `${i + 1}. ${l}`));
      break;
    }
    case "branding": {
      const colours = [payload.primaryColor, payload.secondaryColor].filter((c) => typeof c === "string" && c);
      if (colours.length) lines.push(`Colours: ${colours.join(" and ")}`);
      if (payload.tagline) lines.push(`Tagline: “${String(payload.tagline)}”`);
      if (payload.logoSvgDataUri || payload.logoUrl) lines.push("A logo is drafted too; you can see it in your dashboard.");
      break;
    }
    case "integrations": {
      const providers = list(payload.providers);
      if (providers.length) {
        lines.push(...providers.map((x) => `• ${PROVIDER_LABELS[String(x?.provider)] ?? String(x?.provider ?? "")}${x?.reason ? ` — ${String(x.reason)}` : ""}`));
        lines.push("Nothing is connected now: you add your own account later, from your dashboard.");
      }
      break;
    }
    case "goLive": {
      const checks = list(payload.checks);
      if (checks.length) lines.push(...checks.map((c) => `${c?.ok ? "✅" : "⚠️"} ${String(c?.check ?? "")}${c?.detail ? ` — ${String(c.detail)}` : ""}`));
      break;
    }
  }
  return [p.summary, ...(lines.length ? ["", ...lines] : [])].join("\n").trim();
}
