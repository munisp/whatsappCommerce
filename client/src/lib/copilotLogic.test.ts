/**
 * Unit tests for the pure wave-9 copilot frontend logic
 * (client/src/lib/copilotLogic.ts) plus a defensive render check of
 * WaMenuPreview via react-dom/server (node environment, no jsdom).
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  assembleEditedPayload,
  canGoLive,
  checklistSummary,
  copilotStateMeta,
  extractValidationChecks,
  findResumableSession,
  groupProposalsByKind,
  liveNextSteps,
  mergeTranscript,
  normalizeBrandKit,
  normalizeIntegrations,
  normalizeUseCases,
  normalizeWaMenu,
  proposalKindMeta,
  proposalStatusMeta,
  repairGuidance,
  sortProposalsPendingFirst,
  type CopilotProposal,
  type CopilotSessionSummary,
} from "./copilotLogic";
import { WaMenuPreview } from "../components/copilot/WaMenuPreview";

function proposal(partial: Partial<CopilotProposal>): CopilotProposal {
  return {
    id: partial.id ?? "p1",
    kind: partial.kind ?? "waMenu",
    summary: partial.summary ?? "summary",
    payload: partial.payload ?? {},
    status: partial.status ?? "pending",
    createdAt: partial.createdAt ?? null,
  };
}

describe("groupProposalsByKind", () => {
  it("groups by the four known kinds, preserving order", () => {
    const grouped = groupProposalsByKind([
      proposal({ id: "a", kind: "branding" }),
      proposal({ id: "b", kind: "waMenu" }),
      proposal({ id: "c", kind: "branding" }),
      proposal({ id: "d", kind: "useCases" }),
      proposal({ id: "e", kind: "somethingElse" }),
    ]);
    expect(grouped.branding?.map((p) => p.id)).toEqual(["a", "c"]);
    expect(grouped.waMenu?.map((p) => p.id)).toEqual(["b"]);
    expect(grouped.useCases?.map((p) => p.id)).toEqual(["d"]);
    // Unknown kinds are excluded from the grouped view
    expect(Object.values(grouped).flat().map((p) => p.id)).not.toContain("e");
  });

  it("returns an empty record for empty input", () => {
    expect(groupProposalsByKind([])).toEqual({});
  });
});

describe("sortProposalsPendingFirst", () => {
  it("puts pending proposals first, stable within groups", () => {
    const sorted = sortProposalsPendingFirst([
      proposal({ id: "a", status: "approved" }),
      proposal({ id: "b", status: "pending" }),
      proposal({ id: "c", status: "rejected" }),
      proposal({ id: "d", status: "pending" }),
    ]);
    expect(sorted.map((p) => p.id)).toEqual(["b", "d", "a", "c"]);
  });
});

describe("copilotStateMeta", () => {
  it("maps known states to muted tones with active/terminal flags", () => {
    expect(copilotStateMeta("validating").label).toBe("Validating");
    expect(copilotStateMeta("validating").active).toBe(true);
    expect(copilotStateMeta("live").terminal).toBe(true);
    expect(copilotStateMeta("failed").className).toContain("red");
    expect(copilotStateMeta("abandoned").className).toContain("muted-foreground");
    // Muted outline style — never saturated solid backgrounds
    for (const s of ["intake", "proposing", "approving", "configuring", "validating", "live", "failed", "abandoned"]) {
      expect(copilotStateMeta(s).className).not.toMatch(/bg-(red|green|amber|blue)-[5-9]00(?!\d)/);
    }
  });

  it("falls back gracefully for unknown states", () => {
    const meta = copilotStateMeta("waiting_on_admin");
    expect(meta.label).toBe("waiting on admin");
    expect(meta.className).toContain("muted-foreground");
    expect(meta.terminal).toBe(false);
  });
});

describe("proposalKindMeta / proposalStatusMeta", () => {
  it("labels all four kinds", () => {
    expect(proposalKindMeta("waMenu").label).toBe("WhatsApp menu");
    expect(proposalKindMeta("branding").label).toBe("Brand kit");
    expect(proposalKindMeta("useCases").label).toBe("Use cases");
    expect(proposalKindMeta("integrations").label).toBe("Integrations");
    expect(proposalKindMeta("goLive").label).toBe("goLive");
  });

  it("labels proposal statuses", () => {
    expect(proposalStatusMeta("pending").label).toBe("Awaiting decision");
    expect(proposalStatusMeta("edited").label).toBe("Approved with edits");
    expect(proposalStatusMeta("rejected").className).toContain("red");
  });
});

describe("checklistSummary", () => {
  it("derives pass-rate and allPassed", () => {
    const s = checklistSummary([
      { name: "a", ok: true },
      { name: "b", ok: true },
      { name: "c", ok: false },
      { name: "d", ok: true },
    ]);
    expect(s).toEqual({ total: 4, passed: 3, failed: 1, passRate: 75, allPassed: false });
  });

  it("handles empty and all-pass lists", () => {
    expect(checklistSummary([]).passRate).toBe(0);
    expect(checklistSummary([]).allPassed).toBe(false);
    const s = checklistSummary([{ name: "a", ok: true }]);
    expect(s.passRate).toBe(100);
    expect(s.allPassed).toBe(true);
  });
});

describe("extractValidationChecks", () => {
  it("prefers the explicit checks array and normalizes it", () => {
    const checks = extractValidationChecks({
      transcript: [],
      checks: [{ name: "Menu saved", ok: true, detail: "12 items" }],
    });
    expect(checks).toEqual([{ name: "Menu saved", ok: true, detail: "12 items" }]);
  });

  it("derives checks from ✅/❌ transcript lines, ignoring user messages", () => {
    const checks = extractValidationChecks({
      transcript: [
        { role: "user", text: "❌ fake check — ignore me" },
        { role: "agent", text: "Running validation:\n✅ Menu published — 12 items\n❌ Payment provider — no API key" },
      ],
    });
    expect(checks).toEqual([
      { name: "Menu published", ok: true, detail: "12 items" },
      { name: "Payment provider", ok: false, detail: "no API key" },
    ]);
  });

  it("returns [] for nullish sessions", () => {
    expect(extractValidationChecks(null)).toEqual([]);
    expect(extractValidationChecks(undefined)).toEqual([]);
  });
});

describe("repairGuidance", () => {
  it("returns guidance lines after the first failed check, newest context kept", () => {
    const guidance = repairGuidance([
      { role: "agent", text: "❌ Payment provider — no API key" },
      { role: "agent", text: "Please update the Paystack secret key in Integration Settings, then retry." },
      { role: "user", text: "done" },
    ]);
    expect(guidance).toEqual(["Please update the Paystack secret key in Integration Settings, then retry."]);
  });

  it("returns [] when nothing failed", () => {
    expect(repairGuidance([{ role: "agent", text: "✅ All good" }])).toEqual([]);
  });
});

describe("canGoLive", () => {
  it("requires validating state and all checks passed", () => {
    const passing = [{ name: "a", ok: true }];
    expect(canGoLive("validating", passing)).toBe(true);
    expect(canGoLive("configuring", passing)).toBe(false);
    expect(canGoLive("validating", [{ name: "a", ok: false }])).toBe(false);
    expect(canGoLive("validating", [])).toBe(false);
  });
});

describe("findResumableSession", () => {
  const sessions: CopilotSessionSummary[] = [
    { id: "old", state: "live", updatedAt: "2026-01-03T00:00:00Z" },
    { id: "mid", state: "approving", updatedAt: "2026-01-02T00:00:00Z" },
    { id: "new", state: "intake", updatedAt: "2026-01-04T00:00:00Z" },
    { id: "dead", state: "abandoned", updatedAt: "2026-01-05T00:00:00Z" },
  ];

  it("returns the most recently updated non-terminal session", () => {
    expect(findResumableSession(sessions)?.id).toBe("new");
  });

  it("returns null when all sessions are terminal or input is empty", () => {
    expect(findResumableSession([sessions[0], sessions[3]])).toBeNull();
    expect(findResumableSession([])).toBeNull();
  });
});

describe("normalizeWaMenu", () => {
  it("normalizes a full contract payload", () => {
    const menu = normalizeWaMenu({
      greeting: "Welcome to Ada's Store!",
      useCases: [
        { id: "orders", label: "Track order", enabled: true, order: 2 },
        { id: "browse", label: "Browse products", enabled: false, order: 1 },
      ],
      customItems: [{ label: "Opening hours", response: "Mon–Sat 8–18" }],
      fallback: "Pick a number 1-3",
    });
    expect(menu.greeting).toBe("Welcome to Ada's Store!");
    expect(menu.useCases).toHaveLength(2);
    expect(menu.useCases[1]).toEqual({ id: "browse", label: "Browse products", enabled: false, order: 1 });
    expect(menu.customItems[0].response).toBe("Mon–Sat 8–18");
    expect(menu.fallback).toBe("Pick a number 1-3");
  });

  it("fills placeholders for missing/garbage fields", () => {
    const menu = normalizeWaMenu(null);
    expect(menu.greeting).toContain("Hello");
    expect(menu.useCases).toEqual([]);
    expect(menu.customItems).toEqual([]);
    expect(menu.fallback).toBeTruthy();

    const partial = normalizeWaMenu({ useCases: [{ label: "Only label" }], customItems: [{}] });
    expect(partial.useCases[0]).toEqual({ id: "use-case-1", label: "Only label", enabled: true, order: 1 });
    expect(partial.customItems[0].label).toBe("Item 1");
  });
});

describe("normalizeBrandKit", () => {
  it("keeps valid logo data URI, colors and tagline", () => {
    const kit = normalizeBrandKit({
      brandName: "Ada Stores",
      logoSvgDataUri: "data:image/svg+xml;base64,PHN2Zy8+",
      tagline: "Fresh daily",
      colors: [{ name: "Primary", hex: "#8A5A2B" }, "#123456", { name: "bad", hex: "red" }],
    });
    expect(kit.brandName).toBe("Ada Stores");
    expect(kit.logoSvgDataUri).toBe("data:image/svg+xml;base64,PHN2Zy8+");
    expect(kit.tagline).toBe("Fresh daily");
    expect(kit.colors).toEqual([
      { name: "Primary", hex: "#8A5A2B" },
      { name: "#123456", hex: "#123456" },
    ]);
  });

  it("drops invalid logos and falls back to primaryColor", () => {
    const kit = normalizeBrandKit({ logoSvgDataUri: "https://evil.example/x.svg", primaryColor: "#A1B2C3" });
    expect(kit.logoSvgDataUri).toBeNull();
    expect(kit.colors).toEqual([{ name: "Primary", hex: "#A1B2C3" }]);
    expect(normalizeBrandKit(undefined).colors).toEqual([]);
  });
});

describe("normalizeUseCases / normalizeIntegrations", () => {
  it("ranks use cases with rationale, tolerating strings", () => {
    const items = normalizeUseCases({
      useCases: [{ label: "Reorder", rationale: "repeat buyers", rank: 1 }, "FAQ"],
    });
    expect(items[0]).toEqual({ label: "Reorder", rationale: "repeat buyers", rank: 1 });
    expect(items[1]).toEqual({ label: "FAQ", rationale: "", rank: 2 });
  });

  it("normalizes integration providers with required flag", () => {
    const items = normalizeIntegrations({
      providers: [{ provider: "Paystack", note: "collect payments", required: true }, "Odoo"],
    });
    expect(items[0]).toEqual({ provider: "Paystack", note: "collect payments", required: true });
    expect(items[1]).toEqual({ provider: "Odoo", note: "", required: false });
    expect(normalizeIntegrations(null)).toEqual([]);
  });
});

describe("assembleEditedPayload", () => {
  it("merges valid JSON objects over the original payload", () => {
    const out = assembleEditedPayload({ a: 1, b: 2 }, '{"b": 3, "c": 4}');
    expect(out).toEqual({ a: 1, b: 3, c: 4 });
  });

  it("attaches natural-language edits as adminNote", () => {
    const out = assembleEditedPayload({ a: 1 }, "make the greeting warmer");
    expect(out).toEqual({ a: 1, adminNote: "make the greeting warmer" });
  });

  it("treats non-object JSON as a note and null/empty as no edit", () => {
    expect(assembleEditedPayload({ a: 1 }, '["x"]')).toEqual({ a: 1, adminNote: '["x"]' });
    expect(assembleEditedPayload({ a: 1 }, "   ")).toBeNull();
    expect(assembleEditedPayload("not-an-object", '{"b":2}')).toEqual({ b: 2 });
  });
});

describe("mergeTranscript", () => {
  it("drops optimistic messages once the server echoes them", () => {
    const merged = mergeTranscript(
      [{ role: "user", text: "hello" }, { role: "agent", text: "hi there" }],
      [
        { key: "o1", role: "user", text: "hello" },
        { key: "o2", role: "agent", text: "not yet echoed" },
      ],
    );
    expect(merged.map((m) => m.text)).toEqual(["hello", "hi there", "not yet echoed"]);
  });

  it("defaults unknown roles to agent and keeps system messages", () => {
    const merged = mergeTranscript(
      [{ role: "system", text: "Proposal created" }, { role: "weird" as never, text: "???" }],
      [],
    );
    expect(merged[0].role).toBe("system");
    expect(merged[1].role).toBe("agent");
  });
});

describe("liveNextSteps", () => {
  it("offers connect-WhatsApp and invite-staff next steps", () => {
    const steps = liveNextSteps();
    expect(steps.some((s) => /whatsapp/i.test(s))).toBe(true);
    expect(steps.some((s) => /staff/i.test(s))).toBe(true);
  });
});

describe("WaMenuPreview rendering (react-dom/server)", () => {
  it("renders the full contract payload", () => {
    const html = renderToStaticMarkup(
      createElement(WaMenuPreview, {
        payload: {
          greeting: "Welcome!",
          useCases: [{ id: "u1", label: "Track order", enabled: true, order: 1 }],
          customItems: [{ label: "Hours", response: "9–5" }],
          fallback: "Try again",
        },
      }),
    );
    expect(html).toContain("Welcome!");
    expect(html).toContain("Track order");
    expect(html).toContain("Hours");
    expect(html).toContain("Try again");
  });

  it("renders placeholders for missing fields without crashing", () => {
    const html = renderToStaticMarkup(createElement(WaMenuPreview, { payload: null }));
    expect(html).toContain("Hello");
    expect(html).toContain("No use cases proposed yet.");
    expect(html).toContain("Fallback");
  });

  it("renders partial payloads with defaults", () => {
    const html = renderToStaticMarkup(
      createElement(WaMenuPreview, { payload: { useCases: [{ label: "Only label" }] } }),
    );
    expect(html).toContain("Only label");
    expect(html).toContain("1."); // default order
  });
});
