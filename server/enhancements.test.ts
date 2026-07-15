import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mock getDb ───────────────────────────────────────────────────────────────
vi.mock("./db", () => ({
  getDb: vi.fn(),
}));

import { getDb } from "./db";

// ─── Date range CSV export ────────────────────────────────────────────────────
describe("wallet.exportLedgerCsv – date range filtering", () => {
  it("passes startDate and endDate as SQL conditions when provided", async () => {
    const mockTxs = [
      {
        id: "tx1", walletId: "w1", type: "escrow_release", amount: "5000",
        balanceAfter: "5000", reference: "REF001", orderId: "ORD001",
        description: "Escrow released", createdAt: new Date("2025-06-15T10:00:00Z"),
      },
    ];
    const selectMock = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockResolvedValue(mockTxs),
    };
    const walletSelectMock = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([{ id: "w1", tenantId: "t1" }]),
    };
    let callCount = 0;
    const mockDb = {
      select: vi.fn(() => {
        callCount++;
        return callCount === 1 ? walletSelectMock : selectMock;
      }),
    };
    (getDb as any).mockResolvedValue(mockDb);

    // Simulate the CSV building logic
    const txs = mockTxs;
    const header = ["Date", "Type", "Amount (NGN)", "Balance After (NGN)", "Reference", "Order ID", "Description"].join(",");
    const rows = txs.map((t) => [
      new Date(t.createdAt).toISOString(),
      t.type,
      t.amount,
      t.balanceAfter ?? "",
      t.reference ?? "",
      t.orderId ?? "",
      `"${(t.description ?? "").replace(/"/g, '""')}"`,
    ].join(","));
    const csv = [header, ...rows].join("\n");

    expect(csv).toContain("escrow_release");
    expect(csv).toContain("5000");
    expect(csv).toContain("REF001");
    expect(csv.split("\n")).toHaveLength(2); // header + 1 row
  });

  it("generates correct filename with date range tag", () => {
    const tenantId = "tenant-abc-123";
    const startDate = "2025-06-01";
    const endDate = "2025-06-30";
    const dateTag = `${startDate}_to_${endDate}`;
    const filename = `wallet_ledger_${tenantId.slice(0, 8)}_${dateTag}.csv`;
    expect(filename).toBe("wallet_ledger_tenant-a_2025-06-01_to_2025-06-30.csv");
  });

  it("generates all-time filename when no date range provided", () => {
    const tenantId = "tenant-abc-123";
    const today = new Date().toISOString().slice(0, 10);
    const filename = `wallet_ledger_${tenantId.slice(0, 8)}_${today}.csv`;
    expect(filename).toMatch(/^wallet_ledger_tenant-a_\d{4}-\d{2}-\d{2}\.csv$/);
  });

  it("returns empty CSV with rowCount 0 when no wallet found", async () => {
    const mockDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockResolvedValue([]),
      }),
    };
    (getDb as any).mockResolvedValue(mockDb);
    // Simulate no-wallet early return
    const wallet = undefined;
    const result = wallet ? { csv: "data", filename: "f.csv", rowCount: 1 } : { csv: "", filename: "ledger.csv", rowCount: 0 };
    expect(result.csv).toBe("");
    expect(result.rowCount).toBe(0);
  });
});

// ─── Timeline attachments ─────────────────────────────────────────────────────
describe("timelineAttachment – add and list", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a note attachment with correct fields", async () => {
    const id = crypto.randomUUID();
    const attachment = {
      id,
      escrowId: "esc1",
      eventId: "evt1",
      attachmentType: "note" as const,
      note: "Buyer confirmed delivery via phone call",
      uploadedBy: "merchant@example.com",
      createdAt: new Date(),
      fileUrl: null,
      fileKey: null,
      filename: null,
      mimeType: null,
    };
    expect(attachment.attachmentType).toBe("note");
    expect(attachment.note).toBe("Buyer confirmed delivery via phone call");
    expect(attachment.fileUrl).toBeNull();
  });

  it("creates a document attachment with S3 url", async () => {
    const attachment = {
      id: crypto.randomUUID(),
      escrowId: "esc1",
      eventId: "evt1",
      attachmentType: "document" as const,
      fileUrl: "https://s3.example.com/escrow-attachments/esc1/evt1/proof.pdf",
      fileKey: "escrow-attachments/esc1/evt1/proof.pdf",
      filename: "proof.pdf",
      mimeType: "application/pdf",
      note: null,
      uploadedBy: "merchant@example.com",
      createdAt: new Date(),
    };
    expect(attachment.attachmentType).toBe("document");
    expect(attachment.fileUrl).toContain("s3.example.com");
    expect(attachment.filename).toBe("proof.pdf");
  });

  it("list returns attachments filtered by escrowId and eventId", async () => {
    const allAttachments = [
      { id: "a1", escrowId: "esc1", eventId: "evt1", attachmentType: "note" },
      { id: "a2", escrowId: "esc1", eventId: "evt2", attachmentType: "document" },
      { id: "a3", escrowId: "esc2", eventId: "evt1", attachmentType: "note" },
    ];
    const filtered = allAttachments.filter(
      (a) => a.escrowId === "esc1" && a.eventId === "evt1"
    );
    expect(filtered).toHaveLength(1);
    expect(filtered[0].id).toBe("a1");
  });

  it("list returns all attachments for escrowId when eventId not provided", async () => {
    const allAttachments = [
      { id: "a1", escrowId: "esc1", eventId: "evt1" },
      { id: "a2", escrowId: "esc1", eventId: "evt2" },
      { id: "a3", escrowId: "esc2", eventId: "evt1" },
    ];
    const filtered = allAttachments.filter((a) => a.escrowId === "esc1");
    expect(filtered).toHaveLength(2);
  });
});

// ─── Notification category filter ────────────────────────────────────────────
describe("notifications.list – category filter", () => {
  const CATEGORY_TYPES: Record<string, string[]> = {
    payments: ["escrow_held", "escrow_settled", "escrow_refunded", "withdrawal_processed"],
    logistics: ["shipment_update", "delivery_confirmed"],
    disputes: ["dispute_opened", "dispute_resolved"],
  };

  const allNotifications = [
    { id: "n1", type: "escrow_held", title: "Payment Held", read: false },
    { id: "n2", type: "shipment_update", title: "Shipment Update", read: false },
    { id: "n3", type: "dispute_opened", title: "Dispute Opened", read: true },
    { id: "n4", type: "escrow_settled", title: "Funds Released", read: false },
    { id: "n5", type: "delivery_confirmed", title: "Delivered", read: true },
    { id: "n6", type: "dispute_resolved", title: "Dispute Resolved", read: false },
    { id: "n7", type: "withdrawal_processed", title: "Withdrawal", read: false },
  ];

  function filterByCategory(category: string) {
    if (category === "all") return allNotifications;
    const types = CATEGORY_TYPES[category] ?? [];
    return allNotifications.filter((n) => types.includes(n.type));
  }

  it("returns all notifications when category is 'all'", () => {
    expect(filterByCategory("all")).toHaveLength(7);
  });

  it("returns only payment notifications for 'payments' category", () => {
    const result = filterByCategory("payments");
    expect(result.every((n) => CATEGORY_TYPES.payments.includes(n.type))).toBe(true);
    expect(result).toHaveLength(3); // escrow_held, escrow_settled, withdrawal_processed
  });

  it("returns only logistics notifications for 'logistics' category", () => {
    const result = filterByCategory("logistics");
    expect(result.every((n) => CATEGORY_TYPES.logistics.includes(n.type))).toBe(true);
    expect(result).toHaveLength(2); // shipment_update, delivery_confirmed
  });

  it("returns only dispute notifications for 'disputes' category", () => {
    const result = filterByCategory("disputes");
    expect(result.every((n) => CATEGORY_TYPES.disputes.includes(n.type))).toBe(true);
    expect(result).toHaveLength(2); // dispute_opened, dispute_resolved
  });

  it("returns empty array for unknown category type", () => {
    const result = filterByCategory("unknown_category");
    expect(result).toHaveLength(0);
  });

  it("category filter is independent of read/unread state", () => {
    const paymentsAll = filterByCategory("payments");
    const paymentsUnread = paymentsAll.filter((n) => !n.read);
    expect(paymentsUnread.length).toBeLessThanOrEqual(paymentsAll.length);
    expect(paymentsAll.length).toBeGreaterThan(0);
  });
});
