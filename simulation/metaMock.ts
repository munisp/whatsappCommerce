/**
 * simulation/metaMock.ts — Meta Cloud API + LLM + payment-gateway fetch mock.
 *
 * Installs a global `fetch` interceptor so the REAL production HTTP path in
 * server/services/waSender.ts (and friends) executes end-to-end against a
 * scripted Graph API. Every intercepted call is recorded as a structured
 * object in `outbound[]` with query helpers for journey assertions.
 *
 * Intercepted surfaces:
 *   - graph.facebook.com/v21.0/{phoneNumberId}/messages   (text/template/interactive/media/location_request/mark-read)
 *   - graph.facebook.com/v21.0/{mediaId}                  (media URL lookup)
 *   - graph.facebook.com/v21.0/media-bin/{mediaId}        (media binary download)
 *   - graph.facebook.com/v21.0/{wabaId}/message_templates (list GET / create POST)
 *   - graph.facebook.com/v21.0/{phoneNumberId}?fields=quality_rating…
 *   - graph.facebook.com/v21.0/{catalogId}/items          (catalog upsert/delete batches)
 *   - LLM_BASE_URL/chat/completions                    (scripted NLP/vision LLM)
 *   - OPENAI_BASE_URL/audio/transcriptions             (scripted Whisper)
 *   - api.paystack.co / api.flutterwave.com            (payment link init)
 *   - anything else (non-localhost)                    — recorded + fast 502
 *
 * localhost/127.0.0.1 requests pass through to the real network so the
 * simulation can drive the booted Express server over HTTP.
 */

export interface RecordedCall {
  url: string;
  method: string;
  /** Parsed JSON body when applicable (null for binary/empty). */
  body: any;
  /** Selected headers (authorization redacted). */
  headers: Record<string, string>;
  at: number;
}

export interface WaMessageCall extends RecordedCall {
  waType: string;
  to?: string;
}

let wamidCounter = 0;
export function nextWamid(prefix = "wamid.sim"): string {
  wamidCounter += 1;
  return `${prefix}.${String(wamidCounter).padStart(6, "0")}`;
}

// ── Scriptable state ─────────────────────────────────────────────────────────

export interface SendFailureRule {
  /** HTTP status to return (e.g. 500, 429, 400). */
  status: number;
  /** How many sends to fail before auto-clearing. Default 1. */
  times?: number;
  /** Optional predicate on the message payload. */
  when?: (body: any) => boolean;
}

interface MediaEntry {
  mimeType: string;
  content: Buffer;
}

class MetaMockState {
  /** Every intercepted outbound call, in order. */
  outbound: RecordedCall[] = [];
  /** media id → binary content served on download. */
  media = new Map<string, MediaEntry>();
  /** WABA id → template list (status-sync source). */
  templates = new Map<string, any[]>();
  /** phoneNumberId → Meta quality rating payload. */
  quality = new Map<string, { rating: string; tier: string }>();
  /** catalog id → item requests received (UPDATE/DELETE batches). */
  catalogItems = new Map<string, Map<string, any>>();
  /** Queued one-shot send failures. */
  sendFailures: Array<SendFailureRule & { left: number }> = [];
  /** When true, every /messages POST fails with this status until cleared. */
  failAllSendsStatus: number | null = null;
  /** Activity timestamp — bumped on every intercepted call (settle polling). */
  lastActivityAt = 0;

  reset() {
    this.outbound.length = 0;
    this.media.clear();
    this.templates.clear();
    this.quality.clear();
    this.catalogItems.clear();
    this.sendFailures.length = 0;
    this.failAllSendsStatus = null;
  }
}

export const meta = new MetaMockState();

// ── LLM scripting ────────────────────────────────────────────────────────────

export interface LlmRule {
  /** Match against the last user-message text (string or RegExp) or a predicate. */
  match: string | RegExp | ((userText: string, body: any) => boolean);
  /** JSON object (stringified into the completion) or raw string content. */
  respond: Record<string, unknown> | string | ((userText: string, body: any) => Record<string, unknown> | string);
}

class LlmMockState {
  rules: LlmRule[] = [];
  /** Default response when no rule matches (deterministic NLP fallback). */
  defaultResponse: Record<string, unknown> = {
    reply: "Sorry, I didn't quite get that — type 'menu' to see options.",
    intent: "unknown",
    nextState: "browse",
    extractedItems: [],
    extractedProduct: null,
    extractedQuantity: null,
    extractedAddress: null,
    confidence: 0.1,
  };
  /** Every completion request (for debugging/assertions). */
  calls: Array<{ userText: string; body: any }> = [];

  reset() {
    this.rules = [];
    this.calls = [];
  }

  when(match: LlmRule["match"], respond: LlmRule["respond"]) {
    this.rules.push({ match, respond });
  }
}

export const llm = new LlmMockState();

// ── OpenAI Whisper scripting ─────────────────────────────────────────────────

class OpenAiMockState {
  /** Transcript returned for the next /audio/transcriptions call(s). */
  transcripts: string[] = [];
  defaultTranscript = "";
  calls = 0;
  reset() {
    this.transcripts = [];
    this.defaultTranscript = "";
    this.calls = 0;
  }
}

export const openai = new OpenAiMockState();

// ── Payment gateway scripting ────────────────────────────────────────────────

class PayMockState {
  paystackBaseUrl = "https://checkout.paystack.com/sim";
  flutterwaveBaseUrl = "https://checkout.flutterwave.com/sim";
  calls: RecordedCall[] = [];
  reset() {
    this.calls = [];
  }
}

export const pay = new PayMockState();

// ── Outbound query helpers ───────────────────────────────────────────────────

function parseJsonSafe(raw: string | null): any {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export function waMessageCalls(): WaMessageCall[] {
  return meta.outbound
    .filter((c) => /\/messages$/.test(new URL(c.url).pathname) && c.method === "POST")
    .map((c) => {
      const b = c.body ?? {};
      return { ...c, waType: b.status === "read" ? "read_receipt" : String(b.type ?? "unknown"), to: b.to };
    });
}

export const outbound = {
  all: () => meta.outbound,
  waMessages: waMessageCalls,
  /** Last WA /messages call of a given type (text/template/interactive/image/document/read_receipt). */
  lastOfType(type: string, to?: string): WaMessageCall | undefined {
    const list = waMessageCalls().filter((c) => c.waType === type && (!to || c.to === to));
    return list[list.length - 1];
  },
  ofType(type: string, to?: string): WaMessageCall[] {
    return waMessageCalls().filter((c) => c.waType === type && (!to || c.to === to));
  },
  /** All WA calls to a phone. */
  toPhone(phone: string): WaMessageCall[] {
    const digits = phone.replace(/\D/g, "");
    return waMessageCalls().filter((c) => (c.to ?? "").replace(/\D/g, "") === digits);
  },
  /** WA calls whose JSON body contains the substring (searched in serialized body). */
  findByBody(substr: string, to?: string): WaMessageCall[] {
    return waMessageCalls().filter((c) => JSON.stringify(c.body ?? {}).includes(substr) && (!to || c.to === to));
  },
  lastTo(phone: string): WaMessageCall | undefined {
    const list = outbound.toPhone(phone);
    return list[list.length - 1];
  },
  reset() {
    meta.outbound.length = 0;
    pay.calls.length = 0;
    ledger.calls.length = 0;
    ledger.transfers.length = 0;
  },
};

// ── Interceptor ──────────────────────────────────────────────────────────────

const GRAPH_RE = /^https:\/\/graph\.facebook\.com\/v[\d.]+\/(.+)$/;
const LLM_RE = /^https?:\/\/llm\.sim\.local\//;
const OPENAI_RE = /^https?:\/\/openai\.sim\.local\//;
const LOCAL_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//;

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function record(url: string, method: string, bodyText: string | null, headers: Headers): RecordedCall {
  const hdrs: Record<string, string> = {};
  headers.forEach((v, k) => {
    hdrs[k] = k === "authorization" ? "Bearer <redacted>" : v;
  });
  const call: RecordedCall = {
    url,
    method: method.toUpperCase(),
    body: parseJsonSafe(bodyText),
    headers: hdrs,
    at: Date.now(),
  };
  meta.outbound.push(call);
  meta.lastActivityAt = Date.now();
  return call;
}

async function bodyToText(input: any, init?: RequestInit): Promise<string | null> {
  const b = init?.body ?? (input instanceof Request ? await input.clone().text().catch(() => null) : null);
  if (b == null) return null;
  if (typeof b === "string") return b;
  if (b instanceof URLSearchParams) return b.toString();
  if (b instanceof FormData) return "<multipart-form-data>";
  if (b instanceof Blob) return `<blob:${b.size}b>`;
  if (b instanceof ArrayBuffer) return `<buffer:${b.byteLength}b>`;
  if (ArrayBuffer.isView(b)) return `<view:${b.byteLength}b>`;
  try {
    return String(b);
  } catch {
    return "<unreadable-body>";
  }
}

// ── Send listener (transcript capture) ───────────────────────────────────────

/** Notified for every POST /{phoneNumberId}/messages attempt (success or failure). */
export type WaSendListener = (call: RecordedCall, wamid: string | undefined, failStatus: number | undefined) => void;
let waSendListener: WaSendListener | null = null;
export function onWaSend(listener: WaSendListener | null): void {
  waSendListener = listener;
}

function handleGraph(path: string, url: URL, method: string, bodyText: string | null, call?: RecordedCall): Response {
  const body = parseJsonSafe(bodyText);

  // Media binary download (mock CDN).
  const binMatch = /^media-bin\/(.+)$/.exec(path);
  if (binMatch && method === "GET") {
    const entry = meta.media.get(binMatch[1]);
    if (!entry) return jsonResponse({ error: { message: "media not found" } }, 404);
    return new Response(new Uint8Array(entry.content), {
      status: 200,
      headers: { "Content-Type": entry.mimeType },
    });
  }

  // Catalog items batch.
  const itemsMatch = /^([^/]+)\/items$/.exec(path);
  if (itemsMatch && method === "POST") {
    const catalogId = itemsMatch[1];
    const store = meta.catalogItems.get(catalogId) ?? new Map<string, any>();
    meta.catalogItems.set(catalogId, store);
    const requests = Array.isArray(body?.requests) ? body.requests : [];
    for (const r of requests) {
      if (r?.method === "DELETE") store.delete(String(r.retailer_id));
      else store.set(String(r?.retailer_id ?? ""), r?.data ?? null);
    }
    return jsonResponse({ handles: requests.map(() => ({ id: nextWamid("handle") })), validation_status: [] });
  }

  // WABA message_templates list/create.
  const tplMatch = /^([^/]+)\/message_templates$/.exec(path);
  if (tplMatch) {
    const wabaId = tplMatch[1];
    if (method === "GET") {
      return jsonResponse({ data: meta.templates.get(wabaId) ?? [], paging: {} });
    }
    if (method === "POST") {
      const created = {
        id: `tpl-${Math.random().toString(36).slice(2, 10)}`,
        name: body?.name ?? "unnamed",
        category: body?.category ?? "UTILITY",
        language: body?.language ?? "en_US",
        status: "PENDING",
        components: body?.components ?? [],
      };
      const list = meta.templates.get(wabaId) ?? [];
      list.push(created);
      meta.templates.set(wabaId, list);
      return jsonResponse({ id: created.id, status: "PENDING", category: created.category });
    }
  }

  // /messages POST (all send types + mark-read).
  const msgMatch = /^([^/]+)\/messages$/.exec(path);
  if (msgMatch && method === "POST") {
    // Failure injection.
    const failRule = meta.sendFailures.find((f) => f.left > 0 && (!f.when || f.when(body)));
    const forcedStatus = meta.failAllSendsStatus ?? failRule?.status ?? null;
    if (forcedStatus != null) {
      if (failRule) failRule.left -= 1;
      if (call) waSendListener?.(call, undefined, forcedStatus);
      return jsonResponse(
        { error: { message: `simulated Graph failure ${forcedStatus}`, type: "SimError", code: forcedStatus === 429 ? 4 : 131000 } },
        forcedStatus,
      );
    }
    if (body?.status === "read") {
      if (call) waSendListener?.(call, undefined, undefined);
      return jsonResponse({ success: true });
    }
    const to = body?.to ?? "unknown";
    const wamid = nextWamid();
    if (call) {
      (call as RecordedCall & { wamid?: string }).wamid = wamid;
      waSendListener?.(call, wamid, undefined);
    }
    return jsonResponse({
      messaging_product: "whatsapp",
      contacts: [{ input: to, wa_id: to }],
      messages: [{ id: wamid }],
    });
  }

  // GET /{id}?fields=quality_rating… (phone-number quality lookup).
  if (method === "GET" && url.searchParams.get("fields")?.includes("quality_rating")) {
    const id = decodeURIComponent(path.replace(/\/$/, ""));
    const q = meta.quality.get(id) ?? { rating: "GREEN", tier: "TIER_1K" };
    return jsonResponse({
      id,
      quality_rating: q.rating,
      messaging_limit_tier: q.tier,
      throughput: { level: q.tier },
    });
  }

  // GET /{mediaId} — media object lookup (URL + mime).
  if (method === "GET" && /^[^/]+$/.test(path) && !path.includes("?")) {
    const mediaId = path;
    const entry = meta.media.get(mediaId);
    if (!entry) return jsonResponse({ error: { message: "Object does not exist" } }, 404);
    return jsonResponse({
      messaging_product: "whatsapp",
      url: `https://graph.facebook.com/v21.0/media-bin/${mediaId}`,
      mime_type: entry.mimeType,
      file_size: entry.content.length,
      id: mediaId,
    });
  }

  return jsonResponse({ error: { message: `unmocked Graph path: ${method} ${path}` } }, 404);
}

function extractLastUserText(body: any): string {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) {
      const textPart = m.content.find((p: any) => p?.type === "text");
      const imgPart = m.content.find((p: any) => p?.type === "image_url");
      return `${textPart?.text ?? ""} ${imgPart ? `[image:${String(imgPart.image_url?.url ?? "").slice(0, 400)}]` : ""}`.trim();
    }
  }
  return "";
}

function handleLlm(body: any): Response {
  const userText = extractLastUserText(body);
  llm.calls.push({ userText, body });
  for (const rule of llm.rules) {
    const matched =
      typeof rule.match === "string"
        ? userText.includes(rule.match)
        : rule.match instanceof RegExp
          ? rule.match.test(userText)
          : rule.match(userText, body);
    if (!matched) continue;
    const out = typeof rule.respond === "function" ? rule.respond(userText, body) : rule.respond;
    const content = typeof out === "string" ? out : JSON.stringify(out);
    return jsonResponse({
      id: "chatcmpl-sim",
      created: Math.floor(Date.now() / 1000),
      model: body?.model ?? "sim",
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    });
  }
  // Default: deterministic NLP fallback (valid JSON per the NLP system prompt).
  return jsonResponse({
    id: "chatcmpl-sim",
    created: Math.floor(Date.now() / 1000),
    model: body?.model ?? "sim",
    choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(llm.defaultResponse) }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
  });
}

function handleOpenAi(url: URL, method: string): Response {
  openai.calls += 1;
  if (url.pathname.endsWith("/audio/transcriptions") && method === "POST") {
    const text = openai.transcripts.length > 0 ? openai.transcripts.shift()! : openai.defaultTranscript;
    return jsonResponse({ text });
  }
  return jsonResponse({ error: { message: "unmocked OpenAI path" } }, 404);
}

function handlePay(url: URL, method: string, body: any): Response {
  if (url.hostname.includes("paystack.co") && url.pathname.includes("/transaction/initialize")) {
    const ref = body?.reference ?? "sim-ref";
    return jsonResponse({
      status: true,
      message: "Authorization URL created",
      data: { authorization_url: `${pay.paystackBaseUrl}/${ref}`, reference: ref },
    });
  }
  if (url.hostname.includes("flutterwave.com") && url.pathname.endsWith("/payments")) {
    const ref = body?.tx_ref ?? "sim-ref";
    return jsonResponse({ status: "success", data: { link: `${pay.flutterwaveBaseUrl}/${ref}` } });
  }
  return jsonResponse({ error: "unmocked payment path" }, 404);
}

// ── Ledger bridge scripting ─────────────────────────────────────────────────
// payment.initiate (used by procurement PO payment links) runs a 2-phase
// reserve against the ledger-bridge service BEFORE creating the provider
// link. Without this mock the bridge call 502s and initiation fails with
// "ledger_failed". Responses follow the rust bridge contract (pending_id +
// reserved status); every call is recorded in `ledger.calls` for assertions.

let ledgerPendingCounter = 0;

class LedgerMockState {
  calls: RecordedCall[] = [];
  transfers: Array<{ pendingId: string; body: any }> = [];
  reset() {
    this.calls = [];
    this.transfers = [];
  }
}

export const ledger = new LedgerMockState();

function handleLedger(url: URL, method: string, body: any): Response {
  const path = url.pathname;
  if (path.includes("/accounts/provision") && method === "POST") {
    return jsonResponse({ provisioned: true }, 201);
  }
  if (path.endsWith("/transfer") && method === "POST") {
    ledgerPendingCounter += 1;
    const pendingId = `sim-ledger-pending-${String(ledgerPendingCounter).padStart(6, "0")}`;
    ledger.transfers.push({ pendingId, body });
    return jsonResponse({ pending_id: pendingId, status: "reserved" }, 201);
  }
  if (path.includes("/ledger/commit")) return jsonResponse({ status: "committed" });
  if (path.includes("/ledger/void")) return jsonResponse({ status: "voided" });
  if (path.includes("/ledger/reverse")) return jsonResponse({ status: "reversed" });
  return jsonResponse({ ok: true });
}

let realFetch: typeof fetch | null = null;

/** Install the global fetch interceptor. Idempotent. */
export function installFetchMock(): void {
  if (realFetch) return;
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const u = new URL(url);

    // Real network for localhost (drives the booted sim server).
    if (LOCAL_RE.test(url)) {
      return realFetch!(input, init);
    }

    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const bodyText = await bodyToText(input, init);

    if (GRAPH_RE.test(url)) {
      const path = GRAPH_RE.exec(url)![1].split("?")[0];
      const call = record(url, method, bodyText, headers);
      return handleGraph(path, u, method, bodyText, call);
    }
    if (LLM_RE.test(url)) {
      record(url, method, bodyText, headers);
      return handleLlm(parseJsonSafe(bodyText));
    }
    if (OPENAI_RE.test(url)) {
      record(url, method, bodyText, headers);
      return handleOpenAi(u, method);
    }
    if (u.hostname.includes("paystack.co") || u.hostname.includes("flutterwave.com")) {
      const body = parseJsonSafe(bodyText);
      const call = record(url, method, bodyText, headers);
      pay.calls.push(call);
      return handlePay(u, method, body);
    }
    if (u.hostname.includes("ledger-bridge")) {
      const body = parseJsonSafe(bodyText);
      const call = record(url, method, bodyText, headers);
      ledger.calls.push(call);
      return handleLedger(u, method, body);
    }

    // Anything else: record + fast failure (never hangs the pipeline).
    record(url, method, bodyText, headers);
    return jsonResponse({ error: { message: `sim: no mock for ${u.hostname}` } }, 502);
  }) as typeof fetch;
}

// ── Media scripting helpers ──────────────────────────────────────────────────

/** Register downloadable media content for a media id (binary + mime). */
export function scriptMedia(mediaId: string, content: string | Buffer, mimeType = "image/jpeg"): void {
  meta.media.set(mediaId, { mimeType, content: Buffer.isBuffer(content) ? content : Buffer.from(content) });
}

/** Queue a one-shot (or N-shot) send failure for /messages POSTs. */
export function failNextSends(status: number, times = 1, when?: (body: any) => boolean): void {
  meta.sendFailures.push({ status, times, left: times, when });
}

export function setQuality(phoneNumberId: string, rating: "GREEN" | "YELLOW" | "RED", tier = "TIER_1K"): void {
  meta.quality.set(phoneNumberId, { rating, tier });
}

export function setTemplates(wabaId: string, templates: any[]): void {
  meta.templates.set(wabaId, templates);
}

export function catalogItems(catalogId: string): Map<string, any> {
  return meta.catalogItems.get(catalogId) ?? new Map();
}
