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
  /**
   * Raw Authorization bearer token (w10: lets journeys prove the DECRYPTED
   * tenant secret is what actually left the process). Test-only side channel
   * — never written into transcripts.
   */
  authToken?: string;
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
  /**
   * Wave 9: Graph object registry for GET /{id} lookups (phone numbers and
   * WABAs) used by onboarding validation (checkWhatsAppCredentials /
   * checkWabaAccess). Ids in `validGraphIds` answer 200; ids in
   * `graphIdErrors` answer the scripted HTTP status (failure injection);
   * anything else falls through to the media lookup (404 when unscripted).
   */
  validGraphIds = new Set<string>();
  graphIdErrors = new Map<string, number>();
  /**
   * W10: per-hostname scripted HTTP status for the catch-all branch
   * (integration clients, ERROR_WEBHOOK_URL sink). Lets journeys inject
   * retriable (5xx) / non-retriable (4xx) failures and webhook-sink outages.
   */
  hostStatus = new Map<string, number>();
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
    this.hostStatus.clear();
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
  stripeBaseUrl = "https://checkout.stripe.com/sim/pay";
  monnifyBaseUrl = "https://checkout.monnify.com/sim";
  calls: RecordedCall[] = [];
  /**
   * W11: per-hostname scripted HTTP status for payment-provider init calls
   * (e.g. pay.hostStatus.set("api.paystack.co", 500) forces the adapter's
   * initiate to fail so initiateWithFallback hops to the next chain entry).
   */
  hostStatus = new Map<string, number>();
  /**
   * W11: hostnames routed to the generic custom-gateway mock (declarative
   * customHttp providers, e.g. "api.afripay.example"). Register with
   * registerCustomGatewayHost().
   */
  customGatewayHosts = new Set<string>();
  /**
   * W13: scripted HTTP status for mandate (off-session) charge endpoints —
   * paystack /transaction/charge_authorization and flutterwave
   * /v3/tokenized-charges. While set, those endpoints answer with this
   * status (decline injection); null restores success.
   */
  mandateChargeStatus: number | null = null;
  reset() {
    this.calls = [];
    this.hostStatus.clear();
    this.customGatewayHosts.clear();
    this.mandateChargeStatus = null;
  }
}

export const pay = new PayMockState();

// ── Outbound query helpers ───────────────────────────────────────────────────

// ── Wave 15: scripted ERP connector endpoints (J76) ──────────────────────────
// Odoo JSON-RPC / Twenty GraphQL / Medusa admin endpoints run through the REAL
// integrationSync fetch path; journeys register per-host handlers here so the
// exact request shapes execute with zero network. Calls are recorded for
// dedupe/zero-duplicate assertions.
export interface ErpConnectorCall {
  url: string;
  method: string;
  body: any;
}
export const erp = {
  handlers: new Map<string, (body: any) => { status?: number; json: unknown }>(),
  calls: [] as ErpConnectorCall[],
  script(host: string, handler: (body: any) => { status?: number; json: unknown }): void {
    this.handlers.set(host, handler);
  },
  reset(): void {
    this.handlers.clear();
    this.calls.length = 0;
  },
};

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
    meta.hostStatus.clear();
    pay.reset();
    ledger.calls.length = 0;
    ledger.transfers.length = 0;
    erp.reset();
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
  const authRaw = headers.get("authorization") ?? undefined;
  const call: RecordedCall = {
    url,
    method: method.toUpperCase(),
    body: parseJsonSafe(bodyText),
    headers: hdrs,
    authToken: authRaw?.startsWith("Bearer ") ? authRaw.slice("Bearer ".length) : authRaw,
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

  // whatsapp_business_profile update (wave 9 brand-studio push). Both the
  // text-field POST and the profile_picture_handle POST land here; every call
  // is already recorded in outbound[] by the interceptor.
  const profileMatch = /^([^/]+)\/whatsapp_business_profile$/.exec(path);
  if (profileMatch && method === "POST") {
    return jsonResponse({ success: true });
  }

  // Resumable upload flow (wave 9): 1) POST /{appId}/uploads?file_name=…
  // creates the session, 2) POST /{upload-session-id} (raw bytes) → handle.
  const uploadsMatch = /^([^/]+)\/uploads$/.exec(path);
  if (uploadsMatch && method === "POST") {
    return jsonResponse({ id: nextWamid("upload.sim") });
  }
  if (method === "POST" && /^upload\.sim\.\d+$/.test(path)) {
    return jsonResponse({ h: `handle.${path}` });
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

  // GET /{id} — phone-number / WABA object lookup (wave 9 onboarding
  // validation). Registry first, then failure injection, then media fallback.
  if (method === "GET" && /^[^/]+$/.test(path) && !path.includes("?")) {
    const id = decodeURIComponent(path);
    const errStatus = meta.graphIdErrors.get(id);
    if (errStatus != null) {
      return jsonResponse(
        { error: { message: `simulated Graph object failure ${errStatus} for ${id}`, type: "SimError", code: errStatus } },
        errStatus,
      );
    }
    if (meta.validGraphIds.has(id)) {
      return jsonResponse({
        id,
        verified_name: "Sim Business",
        display_phone_number: "+234 700 000 0000",
        quality_rating: "GREEN",
      });
    }
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

// ── Onboarding copilot scripting (wave 9) ────────────────────────────────────
// The onboarding copilot (server/services/onboardingCopilot/agent.ts) drives
// the shared LLM client with a fixed tool registry and expects OpenAI-style
// tool_calls back. The stock scripted replies are content-only (they serve the
// NLP pipeline), which would stall the copilot's tool loop — so copilot
// requests (detected via the extractIntake tool schema) are answered here with
// deterministic tool_calls derived from the conversation text. Journeys can
// still override everything via llm.when (rules run first).

let copilotCallCounter = 0;
function copilotToolCall(name: string, args: Record<string, unknown>) {
  copilotCallCounter += 1;
  return {
    id: `call_sim_${String(copilotCallCounter).padStart(4, "0")}`,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  };
}

function copilotCompletion(message: Record<string, unknown>, body: any): Response {
  return jsonResponse({
    id: "chatcmpl-sim",
    created: Math.floor(Date.now() / 1000),
    model: body?.model ?? "sim",
    choices: [{ index: 0, message: { role: "assistant", ...message }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
  });
}

/** Last "user: …" line of the copilot's Recent-conversation block. */
function copilotLatestUserLine(userText: string): string {
  const lines = [...userText.matchAll(/^user:\s*(.+)$/gm)].map((m) => m[1]);
  return lines[lines.length - 1] ?? "";
}

/** Facts the scripted extractor pulls from the prospect's free text. */
function copilotExtractFacts(userText: string): Record<string, unknown> {
  const conv = copilotLatestUserLine(userText);
  const lower = conv.toLowerCase();
  const facts: Record<string, unknown> = {};
  const nameMatch = /(?:i run|i own|we run|we own|i have|we have)\s+(?:a\s+|an\s+)?(?:small\s+)?(?:business|shop|store|brand|company)?\s*(?:called\s+)?["']?([A-Za-z0-9'&][A-Za-z0-9'&. ]{1,58}?)["']?(?:\s+in\s+[A-Z]|[,.!]|$)/i.exec(conv);
  if (nameMatch) facts.businessName = nameMatch[1].trim();
  if (/ankara|lace|fabric|fashion|cloth|tailor|adire/.test(lower)) facts.industry = "fashion fabrics";
  else if (/food|restaurant|bakery|meal|kitchen/.test(lower)) facts.industry = "food";
  else if (/electronic|phone|gadget/.test(lower)) facts.industry = "electronics";
  const cityMatch = /\bin\s+([A-Z][a-z]+)/.exec(conv);
  if (cityMatch) facts.city = cityMatch[1];
  if (/deliver|dispatch|ship/.test(lower)) facts.delivery = "offers delivery";
  if (/bank transfer|transfer/.test(lower)) facts.paymentPrefs = ["bank transfer"];
  else if (/cash/.test(lower)) facts.paymentPrefs = ["cash"];
  // Wave 15 (J73): Yoruba/Pidgin intake phrasing — the multilingual copilot
  // accepts threads in yo/pcm, so the scripted extractor understands the
  // common self-description patterns ("orúkọ iṣòwò mi ni X … ní Ìbàdàn").
  if (!facts.businessName) {
    const yoName = /orúkọ iṣòwò(?:\s+mi)?\s+ni\s+([^,.!?]+)/i.exec(conv);
    if (yoName) facts.businessName = yoName[1].trim();
  }
  if (!facts.city) {
    const yoCity = /\bní\s+([A-ZÀ-Ỷ][A-Za-zÀ-ỹ]+)/u.exec(conv);
    if (yoCity) facts.city = yoCity[1];
  }
  if (!facts.industry && /àṣọ|adire|aso oke/i.test(lower)) facts.industry = "fashion fabrics";
  if (!facts.delivery && /ráńṣẹ́|ranṣẹ́|ranse/i.test(lower)) facts.delivery = "offers delivery";
  return facts;
}

/** The copilot's Known-facts JSON blob (already extracted facts). */
function copilotKnownFacts(userText: string): Record<string, any> {
  const m = /Known facts:\s*(\{[^\n]*\})/.exec(userText);
  try {
    return m ? JSON.parse(m[1]) : {};
  } catch {
    return {};
  }
}

/** A waMenu payload that satisfies the shared waMenu contract. */
function copilotMenuPayload(facts: Record<string, any>, greeting?: string): Record<string, unknown> {
  const name = facts.businessName ?? "your business";
  return {
    greeting: greeting ?? `Welcome to ${name}! How can we help you today?`,
    useCases: [
      { id: "shop", label: "Shop products", enabled: true, order: 1 },
      { id: "track", label: "Track my order", enabled: true, order: 2 },
      { id: "support", label: "Get support", enabled: false, order: 3 },
      { id: "booking", label: "Book an appointment", enabled: false, order: 4 },
      { id: "handoff", label: "Talk to a human", enabled: true, order: 5 },
      { id: "procurement", label: "Restock / Buy supplies", enabled: false, order: 6 },
    ],
    customItems: [],
    fallback: "nlp",
  };
}

function handleCopilotLlm(body: any): Response | null {
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  if (!tools.some((t: any) => t?.function?.name === "extractIntake")) return null;
  const userText = extractLastUserText(body);

  // Follow-up round after tool execution — close the loop with plain text.
  if (userText.includes("Tool results:")) {
    return copilotCompletion({ content: "Done — take a look and let me know what you think." }, body);
  }

  // Intake turn → extractIntake tool call with parsed facts.
  if (userText.includes("Extract any business facts")) {
    return copilotCompletion(
      { content: "", tool_calls: [copilotToolCall("extractIntake", copilotExtractFacts(userText))] },
      body,
    );
  }

  // Proposal-generation turn → all four propose* calls at once.
  if (userText.includes("Propose the full setup now")) {
    const facts = copilotKnownFacts(userText);
    const name = facts.businessName ?? "your business";
    return copilotCompletion(
      {
        content: "",
        tool_calls: [
          copilotToolCall("proposeWaMenu", {
            menu: copilotMenuPayload(facts),
            summary: `WhatsApp menu for ${name}: greeting + top use cases`,
          }),
          copilotToolCall("proposeUseCases", {
            ranked: ["shop", "track", "handoff", "support", "booking", "procurement"],
            summary: "Suggested use cases: shop, track, handoff",
          }),
          copilotToolCall("proposeBranding", { vibe: "friendly", summary: `Brand kit for ${name}` }),
          copilotToolCall("proposeIntegrations", {
            providers: [{ provider: "twenty", reason: "CRM to track customer conversations and follow-ups" }],
            summary: "Suggested integrations: twenty",
          }),
        ],
      },
      body,
    );
  }

  // Revision turn (edit path) → re-draft the kinds the feedback mentions.
  const revMatch = /requested these changes:\s*([\s\S]*?)\nRe-draft the affected/.exec(userText);
  if (revMatch) {
    const feedback = revMatch[1];
    const facts = copilotKnownFacts(userText);
    const name = facts.businessName ?? "your business";
    const calls = [];
    if (/purple|violet|lilac|blue|navy|green|red|orange|amber|pink|rose|teal|colou?r|logo|brand|tagline/i.test(feedback)) {
      calls.push(copilotToolCall("proposeBranding", { vibe: feedback, summary: `Brand kit for ${name} (revised)` }));
    }
    if (/greet|welcome|warm|friendl|menu/i.test(feedback)) {
      calls.push(
        copilotToolCall("proposeWaMenu", {
          menu: copilotMenuPayload(facts, `A very warm welcome to ${name}! We're so glad you're here — how can we help today?`),
          summary: `WhatsApp menu for ${name} (revised greeting)`,
        }),
      );
    }
    if (calls.length === 0) {
      calls.push(copilotToolCall("proposeBranding", { vibe: feedback, summary: `Brand kit for ${name} (revised)` }));
    }
    return copilotCompletion({ content: "", tool_calls: calls }, body);
  }

  return copilotCompletion({ content: "Got it — let me know how you'd like to proceed." }, body);
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
  // Wave 9: onboarding copilot tool-call scripting (additive — only fires
  // when the request carries the copilot tool registry).
  const copilot = handleCopilotLlm(body);
  if (copilot) return copilot;

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

function handlePay(url: URL, method: string, body: any, rawBody: string | null): Response {
  // W11: scripted per-host failure injection (fallback-chain fault testing).
  const forced = pay.hostStatus.get(url.hostname);
  if (forced != null) {
    return jsonResponse({ error: { message: `sim: scripted ${forced} for ${url.hostname}` } }, forced);
  }
  if (url.hostname.includes("paystack.co") && url.pathname.includes("/transaction/initialize")) {
    const ref = body?.reference ?? "sim-ref";
    return jsonResponse({
      status: true,
      message: "Authorization URL created",
      data: { authorization_url: `${pay.paystackBaseUrl}/${ref}`, reference: ref },
    });
  }
  // ── W30: refunds (POST /refund) — accepted = queued (status pending) ─────
  if (url.hostname.includes("paystack.co") && url.pathname.endsWith("/refund")) {
    const txRef = body?.transaction ?? "sim-ref";
    return jsonResponse({
      status: true,
      message: "Refund has been queued for processing",
      data: { transaction: { reference: txRef }, status: "pending" },
    });
  }
  // ── W31 approvals: Paystack Transfers (wallet withdrawal payouts) ─────
  // createTransferRecipient / initiateTransfer / verifyTransfer — succeeds
  // deterministically so approved withdrawals execute end-to-end in sim.
  if (url.hostname.includes("paystack.co") && url.pathname.endsWith("/transferrecipient")) {
    return jsonResponse({
      status: true,
      message: "Recipient created",
      data: { recipient_code: `RCP_sim_${body?.account_number ?? "0000"}`, active: true },
    });
  }
  if (url.hostname.includes("paystack.co") && url.pathname.endsWith("/transfer") && method === "POST") {
    const ref = body?.reference ?? "sim-ref";
    return jsonResponse({
      status: true,
      message: "Transfer has been queued",
      data: { status: "success", transfer_code: `TRF_sim_${ref}`, reference: ref },
    });
  }
  if (url.hostname.includes("paystack.co") && url.pathname.includes("/transfer/verify/")) {
    const ref = decodeURIComponent(url.pathname.split("/transfer/verify/")[1] ?? "sim-ref");
    return jsonResponse({
      status: true,
      message: "Transfer retrieved",
      data: { status: "success", transfer_code: `TRF_sim_${ref}`, reference: ref },
    });
  }
  // ── W13: mandate (off-session / tokenized) charges ───────────────────────
  if (url.hostname.includes("paystack.co") && url.pathname.includes("/transaction/charge_authorization")) {
    if (pay.mandateChargeStatus != null) {
      return jsonResponse(
        { status: false, message: `sim: mandate charge declined (${pay.mandateChargeStatus})` },
        pay.mandateChargeStatus,
      );
    }
    return jsonResponse({
      status: true,
      message: "Charge attempted",
      data: { status: "success", reference: body?.reference ?? "sim-ref" },
    });
  }
  if (url.hostname.includes("flutterwave.com") && url.pathname.endsWith("/tokenized-charges")) {
    if (pay.mandateChargeStatus != null) {
      return jsonResponse(
        { status: "error", message: `sim: mandate charge declined (${pay.mandateChargeStatus})` },
        pay.mandateChargeStatus,
      );
    }
    return jsonResponse({
      status: "success",
      data: { status: "successful", tx_ref: body?.tx_ref ?? "sim-ref" },
    });
  }
  if (url.hostname.includes("flutterwave.com") && url.pathname.endsWith("/payments")) {
    const ref = body?.tx_ref ?? "sim-ref";
    return jsonResponse({ status: "success", data: { link: `${pay.flutterwaveBaseUrl}/${ref}` } });
  }
  // ── W11: Stripe (Checkout Sessions) ──────────────────────────────────────
  if (url.hostname === "api.stripe.com") {
    if (method === "POST" && url.pathname === "/v1/checkout/sessions") {
      const params = new URLSearchParams(rawBody ?? "");
      const ref = params.get("client_reference_id") ?? "sim-ref";
      return jsonResponse({
        id: `cs_sim_${ref}`,
        object: "checkout.session",
        client_reference_id: ref,
        payment_status: "unpaid",
        status: "open",
        url: `${pay.stripeBaseUrl}/${ref}`,
      });
    }
    if (method === "GET" && url.pathname === "/v1/checkout/sessions") {
      return jsonResponse({ object: "list", data: [], has_more: false });
    }
  }
  // ── W11: Monnify (auth login + init-transaction + status) ────────────────
  if (url.hostname === "api.monnify.com") {
    if (method === "POST" && url.pathname === "/api/v1/auth/login") {
      return jsonResponse({
        requestSuccessful: true,
        responseBody: { accessToken: "sim-monnify-token", expiresIn: 3600 },
      });
    }
    if (method === "POST" && url.pathname === "/api/v1/merchant/transactions/init-transaction") {
      const ref = body?.paymentReference ?? "sim-ref";
      return jsonResponse({
        requestSuccessful: true,
        responseBody: { paymentReference: ref, checkoutUrl: `${pay.monnifyBaseUrl}/${ref}` },
      });
    }
    if (method === "GET" && url.pathname.startsWith("/api/v2/transactions/")) {
      const ref = decodeURIComponent(url.pathname.slice("/api/v2/transactions/".length));
      return jsonResponse({
        requestSuccessful: true,
        responseBody: { paymentReference: ref, paymentStatus: "PAID", amountPaid: 0 },
      });
    }
  }
  // ── W11: generic custom gateway (declarative customHttp providers) ───────
  // Any registered host answers POSTs with a hosted-url payload matching the
  // AfriPay-style responseMapping ($.data.hosted_url / $.data.ref); other
  // methods answer a benign success payload for status probes.
  if (pay.customGatewayHosts.has(url.hostname)) {
    if (method !== "GET") {
      const ref = body?.ref ?? body?.reference ?? body?.paymentReference ?? "sim-ref";
      return jsonResponse({
        data: { hosted_url: `https://pay.${url.hostname}/sim/${ref}`, ref, status: "pending" },
      });
    }
    return jsonResponse({ charge: { state: "pending", amount_minor: 0 } });
  }
  return jsonResponse({ error: "unmocked payment path" }, 404);
}

/** W11: route a hostname to the generic custom-gateway mock. */
export function registerCustomGatewayHost(hostname: string): void {
  pay.customGatewayHosts.add(hostname);
}

/** W11: script the next HTTP status for a payment host (fallback testing). */
export function setPayHostStatus(hostname: string, status: number | null): void {
  if (status == null) pay.hostStatus.delete(hostname);
  else pay.hostStatus.set(hostname, status);
}

/** W13: script the HTTP status for mandate charge endpoints (decline injection). */
export function setMandateChargeStatus(status: number | null): void {
  pay.mandateChargeStatus = status;
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
    if (
      u.hostname.includes("paystack.co") ||
      u.hostname.includes("flutterwave.com") ||
      u.hostname === "api.stripe.com" ||
      u.hostname === "api.monnify.com" ||
      pay.customGatewayHosts.has(u.hostname)
    ) {
      const body = parseJsonSafe(bodyText);
      const call = record(url, method, bodyText, headers);
      pay.calls.push(call);
      return handlePay(u, method, body, bodyText);
    }
    if (u.hostname.includes("ledger-bridge")) {
      const body = parseJsonSafe(bodyText);
      const call = record(url, method, bodyText, headers);
      ledger.calls.push(call);
      return handleLedger(u, method, body);
    }

    // Wave 15: scripted ERP connector endpoints (J76) — per-host handlers.
    if (erp.handlers.has(u.hostname)) {
      record(url, method, bodyText, headers);
      const body = parseJsonSafe(bodyText);
      erp.calls.push({ url, method, body });
      const out = erp.handlers.get(u.hostname)!(body);
      return jsonResponse(out.json, out.status ?? 200);
    }

    // Anything else: record + fast failure (never hangs the pipeline).
    // w10: meta.hostStatus can script a specific status per hostname
    // (integration-client fault injection, ERROR_WEBHOOK_URL sink flaps).
    record(url, method, bodyText, headers);
    const hostStatus = meta.hostStatus.get(u.hostname) ?? 502;
    return jsonResponse(
      hostStatus >= 400 ? { error: { message: `sim: no mock for ${u.hostname}` } } : { ok: true },
      hostStatus,
    );
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

// ── Wave 9: Graph object registry (phone numbers / WABAs for validation) ────

/** GET /{id} answers 200 (phone-number or WABA object exists + readable). */
export function registerGraphObject(id: string): void {
  meta.graphIdErrors.delete(id);
  meta.validGraphIds.add(id);
}

/** GET /{id} answers the scripted HTTP error status (validation failure injection). */
export function failGraphObject(id: string, status: number): void {
  meta.validGraphIds.delete(id);
  meta.graphIdErrors.set(id, status);
}

/** Remove an id from both registries (falls back to media lookup / 404). */
export function clearGraphObject(id: string): void {
  meta.validGraphIds.delete(id);
  meta.graphIdErrors.delete(id);
}
