/**
 * What the Telegram settings card actually SHOWS an operator, rendered for real (react-dom/server) with only the
 * data hooks mocked. Guards the things that matter: the bot token is never shown (only its masked form), the
 * buttons that cannot work yet are disabled (and say why), and a configured business gets a working card.
 */
import { describe, it, expect, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const RAW_TOKEN = "123456789:rawtokenmustneverappearanywhereABCDEFGH01";
const ADDRESS = "https://app.example.test/api/webhooks/telegram/t-acme";

interface Cfg {
  tenantId: string; enabled: boolean; botUsername: string; botToken: string; webhookSecretSet: boolean;
  configured: boolean; serverEnabled: boolean; webhookUrl: string | null;
}
const base: Cfg = {
  tenantId: "t-acme", enabled: false, botUsername: "", botToken: "", webhookSecretSet: false,
  configured: false, serverEnabled: true, webhookUrl: ADDRESS,
};
const state: { cfg: Cfg | undefined } = { cfg: base };

const mutation = () => ({ useMutation: () => ({ mutate: vi.fn(), isPending: false }) });
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({ tenant: { getTelegramConfig: { invalidate: vi.fn() } } }),
    tenant: {
      getTelegramConfig: { useQuery: () => ({ data: state.cfg, isLoading: false }) },
      updateTelegramConfig: mutation(),
      testTelegramConnection: mutation(),
      registerTelegramWebhook: mutation(),
    },
  },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

async function render(cfg: Partial<Cfg> | undefined): Promise<string> {
  state.cfg = cfg === undefined ? undefined : { ...base, ...cfg };
  const { TelegramSetupCard } = await import("./TelegramSetupCard");
  return renderToStaticMarkup(React.createElement(TelegramSetupCard, { tenantId: "t-acme" }));
}
/** The attributes of the <button> whose label contains `label` (so 'disabled' can be asserted). */
function buttonAttrs(html: string, label: string): string {
  const m = html.match(new RegExp(`<button([^>]*)>(?:(?!</button>)[\\s\\S])*?${label}`));
  if (!m) throw new Error(`no button labelled "${label}" in the markup`);
  return m[1];
}
// The real attribute only: every button's Tailwind class list contains "disabled:pointer-events-none", which a
// looser /disabled/ test would count (making every button look disabled, and every "is disabled" check vacuous).
const isDisabled = (html: string, label: string) => /\sdisabled=""/.test(buttonAttrs(html, label));

describe("test harness", () => {
  it("can tell a disabled button from an enabled one (else the checks below prove nothing)", async () => {
    const off = await render({});
    const on = await render({ enabled: true, configured: true, botUsername: "b_bot", botToken: "••••••••ABCD" });
    expect(isDisabled(off, "Test connection")).toBe(true);
    expect(isDisabled(on, "Test connection")).toBe(false);
  });
});

describe("TelegramSetupCard — nothing set up yet, feature switched off on the server", () => {
  it("says so, and offers only what can work", async () => {
    const html = await render({ serverEnabled: false });
    expect(html).toContain("Not set up");
    expect(html).toContain("Telegram is switched off on this server");
    expect(html).toContain("123456789:AA…"); // the empty token field tells you where the token comes from
    expect(isDisabled(html, "Save")).toBe(true); // nothing typed yet
    expect(isDisabled(html, "Test connection")).toBe(true); // no token stored
    expect(isDisabled(html, "Register webhook")).toBe(true);
  });
});

describe("TelegramSetupCard — a configured business", () => {
  const configured = { enabled: true, configured: true, botUsername: "acme_store_bot", botToken: "••••••••ABCD", webhookSecretSet: true };

  it("shows the token only masked, never the real one, and the address Telegram will use", async () => {
    const html = await render(configured);
    expect(html).toContain("Enabled");
    expect(html).toContain("Stored: ••••••••ABCD — type to replace");
    expect(html).not.toContain(RAW_TOKEN);
    expect(html).toContain(ADDRESS);
    expect(html).toContain("acme_store_bot");
  });

  it("the token field is a password field that does not autofill", async () => {
    const html = await render(configured);
    const field = html.match(/<input[^>]*id="tg-bot-token"[^>]*>/)?.[0] ?? "";
    expect(field).toMatch(/type="password"/);
    expect(field).toMatch(/autoComplete="off"/);
    expect(field).not.toMatch(/value="[^"]+"/); // nothing pre-filled
  });

  it("Test connection and Register webhook are available; Save is not until something changes", async () => {
    const html = await render(configured);
    expect(isDisabled(html, "Test connection")).toBe(false);
    expect(isDisabled(html, "Register webhook")).toBe(false);
    expect(isDisabled(html, "Save")).toBe(true);
    expect(html).not.toContain("switched off on this server");
  });
});

describe("TelegramSetupCard — cases where registering cannot work", () => {
  const configured = { enabled: true, configured: true, botUsername: "acme_store_bot", botToken: "••••••••ABCD" };

  it("switch off on the server: explains it and disables Register (but the saved bot can still be tested)", async () => {
    const html = await render({ ...configured, serverEnabled: false });
    expect(html).toContain("Telegram is switched off on this server");
    expect(isDisabled(html, "Register webhook")).toBe(true);
    expect(isDisabled(html, "Test connection")).toBe(false);
  });

  it("app address is not https: explains it, shows no address, and disables Register", async () => {
    const html = await render({ ...configured, webhookUrl: null });
    expect(html).toContain("not https");
    expect(html).not.toContain("/api/webhooks/telegram/");
    expect(html).not.toContain("Webhook address"); // no empty box either
    expect(isDisabled(html, "Register webhook")).toBe(true);
  });

  it("a token is saved but Telegram is not enabled for the business: says so and will not register", async () => {
    const html = await render({ enabled: false, configured: false, botUsername: "acme_store_bot", botToken: "••••••••ABCD" });
    expect(html).toContain("Saved, not enabled");
    expect(isDisabled(html, "Register webhook")).toBe(true);
    expect(isDisabled(html, "Test connection")).toBe(false);
  });
});
