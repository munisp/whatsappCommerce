/**
 * W28 odoo-sync — Odoo ERP adapter layer.
 *
 * OdooAdapter abstracts the Odoo JSON-RPC API (authenticate, createPartner,
 * createInvoice, createVendorBill, createPayment, attachReceipt). Two
 * implementations:
 *   - JsonRpcOdooAdapter: fetch-based client against a real Odoo instance
 *     (/jsonrpc endpoint, api-key auth via the `authenticate` call with the
 *     api key as password). Per-tenant connection from odoo_configs.
 *   - MockOdooAdapter: deterministic in-memory fake — ids are HMAC-derived
 *     from (tenantId, model, payload) so tests are reproducible and full
 *     state is inspectable for assertions. Used whenever the tenant config
 *     url is "mock://" or ODOO_MOCK=true, and ALWAYS in tests/simulation.
 *
 * Registry: getOdooAdapter(tenantId) resolves the tenant's odoo_configs row
 * (decrypting the api key via services/crypto/secrets) and returns a ready
 * adapter, or null when the tenant has no enabled config — callers treat
 * null as "sync disabled for this tenant" (enqueue-only / skip).
 *
 * Determinism: integer cents everywhere; no Math.random; mock ids are
 * HMAC-SHA256(ODOO_MOCK_SECRET ?? 'odoo-mock-dev', tenantId|model|canonical
 * payload) truncated to a stable numeric id.
 */
import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../../db";
import { odooConfigs } from "../../../drizzle/schema";
import { decryptSecret } from "../crypto/secrets";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface OdooInvoiceLine {
  description: string;
  quantity: number;
  /** integer cents, per-unit */
  unitPriceCents: number;
}

export interface OdooInvoiceInput {
  partnerRef: string; // platform customer ref (phone/id) — partner created/resolved
  partnerName: string;
  reference: string; // platform order number — idempotency anchor
  lines: OdooInvoiceLine[];
  currency: string;
  /** integer cents — must equal sum(lines) */
  totalCents: number;
  accountMapping?: Record<string, unknown> | null;
}

export interface OdooVendorBillInput {
  vendorName: string;
  reference: string; // platform expense id
  amountCents: number;
  currency: string;
  category?: string | null;
  note?: string | null;
  expenseDate?: string | null; // ISO date
  accountMapping?: Record<string, unknown> | null;
}

export interface OdooPaymentInput {
  paymentType: "inbound" | "outbound";
  reference: string; // platform payout / loan id
  amountCents: number;
  currency: string;
  partnerName?: string | null;
  memo?: string | null;
  accountMapping?: Record<string, unknown> | null;
}

export interface OdooReceiptAttachment {
  /** remote vendor bill id */
  billId: number;
  name: string;
  base64: string;
  mimeType: string;
}

export interface OdooAdapter {
  readonly kind: "jsonrpc" | "mock";
  /** Validates credentials; returns the Odoo uid on success. Throws on failure. */
  authenticate(): Promise<{ uid: number }>;
  /** Find-or-create a partner by ref; returns the Odoo partner id. */
  createPartner(ref: string, name: string): Promise<{ partnerId: number }>;
  createInvoice(input: OdooInvoiceInput): Promise<{ invoiceId: number }>;
  createVendorBill(input: OdooVendorBillInput): Promise<{ billId: number }>;
  createPayment(input: OdooPaymentInput): Promise<{ paymentId: number }>;
  attachReceipt(att: OdooReceiptAttachment): Promise<{ attachmentId: number }>;
}

export interface OdooConnectionConfig {
  url: string;
  db: string;
  username?: string | null;
  apiKey?: string | null;
}

// ─── JSON-RPC client ────────────────────────────────────────────────────────

export class OdooRpcError extends Error {
  constructor(message: string, readonly code?: number) {
    super(message);
    this.name = "OdooRpcError";
  }
}

export class JsonRpcOdooAdapter implements OdooAdapter {
  readonly kind = "jsonrpc" as const;
  private uid: number | null = null;
  private callSeq = 0;

  constructor(private readonly cfg: OdooConnectionConfig) {}

  private async rpc(service: string, method: string, args: unknown[]): Promise<unknown> {
    this.callSeq += 1;
    const res = await fetch(`${this.cfg.url.replace(/\/+$/, "")}/jsonrpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "call",
        id: this.callSeq,
        params: { service, method, args },
      }),
    });
    if (!res.ok) throw new OdooRpcError(`odoo http ${res.status}`, res.status);
    const body = (await res.json().catch(() => null)) as
      | { result?: unknown; error?: { message?: string; code?: number } }
      | null;
    if (!body) throw new OdooRpcError("odoo returned non-json response");
    if (body.error) throw new OdooRpcError(body.error.message ?? "odoo rpc error", body.error.code);
    return body.result;
  }

  async authenticate(): Promise<{ uid: number }> {
    const uid = await this.rpc("common", "authenticate", [
      this.cfg.db,
      this.cfg.username ?? "api",
      this.cfg.apiKey ?? "",
      {},
    ]);
    if (typeof uid !== "number" || !uid) throw new OdooRpcError("odoo authentication failed");
    this.uid = uid;
    return { uid };
  }

  private async execute(model: string, method: string, args: unknown[], kwargs: Record<string, unknown> = {}): Promise<unknown> {
    if (this.uid == null) await this.authenticate();
    return this.rpc("object", "execute_kw", [
      this.cfg.db,
      this.uid,
      this.cfg.apiKey ?? "",
      model,
      method,
      args,
      kwargs,
    ]);
  }

  private async createId(model: string, values: Record<string, unknown>): Promise<number> {
    const id = await this.execute(model, "create", [values]);
    if (typeof id !== "number") throw new OdooRpcError(`odoo ${model}.create returned ${JSON.stringify(id)}`);
    return id;
  }

  async createPartner(ref: string, name: string): Promise<{ partnerId: number }> {
    const found = (await this.execute("res.partner", "search", [[["ref", "=", ref]]], { limit: 1 })) as number[];
    if (Array.isArray(found) && found.length > 0) return { partnerId: found[0] };
    const partnerId = await this.createId("res.partner", { name, ref });
    return { partnerId };
  }

  async createInvoice(input: OdooInvoiceInput): Promise<{ invoiceId: number }> {
    const { partnerId } = await this.createPartner(input.partnerRef, input.partnerName);
    const invoiceId = await this.createId("account.move", {
      move_type: "out_invoice",
      partner_id: partnerId,
      ref: input.reference,
      currency_id: input.currency,
      invoice_line_ids: input.lines.map((l) => [0, 0, {
        name: l.description,
        quantity: l.quantity,
        price_unit: l.unitPriceCents / 100,
      }]),
    });
    return { invoiceId };
  }

  async createVendorBill(input: OdooVendorBillInput): Promise<{ billId: number }> {
    const { partnerId } = await this.createPartner(`vendor:${input.vendorName}`, input.vendorName);
    const billId = await this.createId("account.move", {
      move_type: "in_invoice",
      partner_id: partnerId,
      ref: input.reference,
      invoice_date: input.expenseDate ?? undefined,
      invoice_line_ids: [[0, 0, {
        name: input.note ?? input.category ?? "expense",
        quantity: 1,
        price_unit: input.amountCents / 100,
      }]],
    });
    return { billId };
  }

  async createPayment(input: OdooPaymentInput): Promise<{ paymentId: number }> {
    const paymentId = await this.createId("account.payment", {
      payment_type: input.paymentType,
      amount: input.amountCents / 100,
      ref: input.reference,
      memo: input.memo ?? input.reference,
    });
    return { paymentId };
  }

  async attachReceipt(att: OdooReceiptAttachment): Promise<{ attachmentId: number }> {
    const attachmentId = await this.createId("ir.attachment", {
      name: att.name,
      type: "binary",
      datas: att.base64,
      mimetype: att.mimeType,
      res_model: "account.move",
      res_id: att.billId,
    });
    return { attachmentId };
  }
}

// ─── Deterministic mock ─────────────────────────────────────────────────────

function mockSecret(): string {
  return process.env.ODOO_MOCK_SECRET ?? "odoo-mock-dev-secret";
}

function canonical(v: unknown): string {
  if (v == null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
}

/** HMAC-derived positive int31 — deterministic per (tenant, model, payload). */
export function mockOdooId(tenantId: string, model: string, payload: unknown): number {
  const h = createHmac("sha256", mockSecret())
    .update(`${tenantId}|${model}|${canonical(payload)}`)
    .digest();
  return (h.readUInt32BE(0) & 0x7fffffff) || 1;
}

export interface MockOdooState {
  authed: { db: string; username: string | null }[];
  partners: { id: number; ref: string; name: string }[];
  invoices: { id: number; input: OdooInvoiceInput; partnerId: number }[];
  vendorBills: { id: number; input: OdooVendorBillInput }[];
  payments: { id: number; input: OdooPaymentInput }[];
  attachments: { id: number; att: OdooReceiptAttachment }[];
}

export class MockOdooAdapter implements OdooAdapter {
  readonly kind = "mock" as const;
  readonly state: MockOdooState = {
    authed: [], partners: [], invoices: [], vendorBills: [], payments: [], attachments: [],
  };
  /** Test hook: when set, the next N adapter calls throw this error. */
  failNext = 0;
  failWith: Error = new OdooRpcError("mock odoo failure");

  constructor(private readonly tenantId: string, private readonly cfg?: OdooConnectionConfig) {}

  private gate(): void {
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw this.failWith;
    }
  }

  private id(model: string, payload: unknown): number {
    return mockOdooId(this.tenantId, model, payload);
  }

  async authenticate(): Promise<{ uid: number }> {
    this.gate();
    this.state.authed.push({ db: this.cfg?.db ?? "mock", username: this.cfg?.username ?? null });
    return { uid: this.id("res.users", { db: this.cfg?.db ?? "mock" }) };
  }

  async createPartner(ref: string, name: string): Promise<{ partnerId: number }> {
    this.gate();
    const existing = this.state.partners.find((p) => p.ref === ref);
    if (existing) return { partnerId: existing.id };
    const id = this.id("res.partner", { ref });
    this.state.partners.push({ id, ref, name });
    return { partnerId: id };
  }

  async createInvoice(input: OdooInvoiceInput): Promise<{ invoiceId: number }> {
    this.gate();
    const { partnerId } = await this.createPartner(input.partnerRef, input.partnerName);
    const id = this.id("account.move.out_invoice", input);
    this.state.invoices.push({ id, input, partnerId });
    return { invoiceId: id };
  }

  async createVendorBill(input: OdooVendorBillInput): Promise<{ billId: number }> {
    this.gate();
    const id = this.id("account.move.in_invoice", input);
    this.state.vendorBills.push({ id, input });
    return { billId: id };
  }

  async createPayment(input: OdooPaymentInput): Promise<{ paymentId: number }> {
    this.gate();
    const id = this.id("account.payment", input);
    this.state.payments.push({ id, input });
    return { paymentId: id };
  }

  async attachReceipt(att: OdooReceiptAttachment): Promise<{ attachmentId: number }> {
    this.gate();
    const id = this.id("ir.attachment", att);
    this.state.attachments.push({ id, att });
    return { attachmentId: id };
  }
}

// ─── Registry ───────────────────────────────────────────────────────────────

/** Process-wide mock instances so tests/journeys can inspect state per tenant. */
const mockInstances = new Map<string, MockOdooAdapter>();

/** Test/journey hook: get the mock adapter instance for a tenant (if resolved). */
export function getMockOdooAdapter(tenantId: string): MockOdooAdapter | undefined {
  return mockInstances.get(tenantId);
}

/** Test hook: clear mock adapter instances between tests/journeys. */
export function resetOdooAdapters(): void {
  mockInstances.clear();
}

export interface ResolvedOdoo {
  adapter: OdooAdapter;
  config: typeof odooConfigs.$inferSelect;
}

/**
 * Resolve the tenant's Odoo adapter from odoo_configs. Returns null when no
 * enabled config exists. A config url of "mock://" (or env ODOO_MOCK=true,
 * or NODE_ENV=test) resolves to the deterministic MockOdooAdapter; anything
 * else builds a fetch-based JSON-RPC client. The api key is decrypted from
 * at-rest encryption (legacy plaintext passes through).
 */
export async function getOdooAdapter(tenantId: string): Promise<ResolvedOdoo | null> {
  const db = await getDb();
  if (!db) return null;
  const [config] = await db.select().from(odooConfigs).where(eq(odooConfigs.tenantId, tenantId)).limit(1);
  if (!config || !config.enabled) return null;

  const apiKey = config.apiKey ? decryptSecret(config.apiKey) : null;
  const cfg: OdooConnectionConfig = {
    url: config.url,
    db: config.db,
    username: config.username,
    apiKey,
  };
  const useMock =
    config.url.startsWith("mock://") ||
    process.env.ODOO_MOCK === "true" ||
    process.env.NODE_ENV === "test";
  if (useMock) {
    let mock = mockInstances.get(tenantId);
    if (!mock) {
      mock = new MockOdooAdapter(tenantId, cfg);
      mockInstances.set(tenantId, mock);
    }
    return { adapter: mock, config };
  }
  return { adapter: new JsonRpcOdooAdapter(cfg), config };
}

/**
 * Resolve an adapter for a one-off connection test from NOT-yet-saved
 * settings (portal "test connection"). Never persists anything.
 */
export function adapterForConnectionTest(cfg: OdooConnectionConfig): OdooAdapter {
  if (cfg.url.startsWith("mock://") || process.env.ODOO_MOCK === "true" || process.env.NODE_ENV === "test") {
    return new MockOdooAdapter("connection-test", cfg);
  }
  return new JsonRpcOdooAdapter(cfg);
}
