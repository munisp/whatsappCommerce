/**
 * Mojaloop FSPIOP Adapter
 * ========================
 * Implements the Mojaloop FSPIOP API v1.1 for interbank transfers.
 * Connects to a NIBSS-licensed DFSP (Digital Financial Service Provider)
 * or a ModusBox/Mowali switch.
 *
 * Key flows:
 *  1. GET /parties/{Type}/{ID}       — Party lookup (resolve phone → IBAN)
 *  2. POST /quotes                   — Get transfer quote (fees, FX)
 *  3. POST /transfers                — Execute transfer
 *  4. PUT /transfers/{ID}            — Receive transfer fulfillment callback
 *
 * Reference: https://docs.mojaloop.io/api/fspiop/
 */

import crypto from "crypto";
import https from "https";

// === W35 mojaloop-otel ===
// Manual fail-open spans around each FSPIOP call (mojaloop.prepare |
// mojaloop.fulfil | mojaloop.quote) + W3C traceparent injection reusing the
// W34 injectTraceHeaders helper. Fail-open: any telemetry fault runs the
// FSPIOP call bare; adapter behavior is unchanged when OTEL_ENABLED is unset.
import { trace, SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { injectTraceHeaders, isTelemetryActive, noteTelemetryError } from "../../server/_core/telemetry";

async function withMojaloopSpan<T>(op: "prepare" | "fulfil" | "quote" | "lookup", fn: () => Promise<T>): Promise<T> {
  if (!isTelemetryActive()) return fn();
  try {
    const tracer = trace.getTracer("whatsapp-commerce-mojaloop");
    return await tracer.startActiveSpan(
      `mojaloop.${op}`,
      { kind: SpanKind.CLIENT, attributes: { "peer.service": "mojaloop", "mojaloop.operation": op } },
      async (span) => {
        try {
          const result = await fn();
          span.setStatus({ code: SpanStatusCode.OK });
          return result;
        } catch (err) {
          span.recordException(err as Error);
          span.setStatus({ code: SpanStatusCode.ERROR });
          (err as { __w35MojaloopCallError?: boolean }).__w35MojaloopCallError = true;
          throw err;
        } finally {
          span.end();
        }
      },
    );
  } catch (err) {
    if (err && (err as { __w35MojaloopCallError?: boolean }).__w35MojaloopCallError) throw err;
    noteTelemetryError("mojaloop-span", err);
    return fn();
  }
}
// === END W35 mojaloop-otel ===

export interface MojaloopConfig {
  switchUrl: string;         // e.g. https://central-ledger.nibss.ng
  fspId: string;             // Your DFSP ID registered with the switch
  clientCert: string;        // mTLS client certificate (PEM)
  clientKey: string;         // mTLS client private key (PEM)
  caCert: string;            // Switch CA certificate (PEM)
  jwtSigningKey: string;     // JWS signing key for FSPIOP-Signature
}

export interface PartyLookupResult {
  partyIdType: string;
  partyIdentifier: string;
  partyName: string;
  fspId: string;
  supportedCurrencies: string[];
}

export interface QuoteRequest {
  quoteId: string;
  transactionId: string;
  payerFspId: string;
  payeeFspId: string;
  payerIdType: string;
  payerIdentifier: string;
  payeeIdType: string;
  payeeIdentifier: string;
  amount: string;
  currency: string;
  transactionType: "TRANSFER" | "PAYMENT" | "DEPOSIT" | "WITHDRAWAL";
  note?: string;
}

export interface QuoteResponse {
  quoteId: string;
  transferAmount: string;
  payeeReceiveAmount: string;
  payeeFspFee: string;
  payeeFspCommission: string;
  expiration: string;
  ilpPacket: string;
  condition: string;
}

export interface TransferRequest {
  transferId: string;
  payerFspId: string;
  payeeFspId: string;
  amount: string;
  currency: string;
  ilpPacket: string;
  condition: string;
  expiration: string;
}

export class MojaloopFSPIOPAdapter {
  private config: MojaloopConfig;
  private agent: https.Agent;

  constructor(config: MojaloopConfig) {
    this.config = config;
    // mTLS agent for all Mojaloop API calls
    this.agent = new https.Agent({
      cert: config.clientCert,
      key: config.clientKey,
      ca: config.caCert,
      rejectUnauthorized: true,
    });
  }

  /**
   * Party Lookup — resolve a phone number or account ID to a DFSP party
   */
  async lookupParty(
    idType: "MSISDN" | "ACCOUNT_ID" | "PERSONAL_ID",
    identifier: string
  ): Promise<PartyLookupResult> {
    const url = `${this.config.switchUrl}/parties/${idType}/${identifier}`;
    // W35 mojaloop-otel: traceparent injected INSIDE the span so it carries
    // the mojaloop.lookup span's context (injectTraceHeaders no-ops when
    // telemetry is off).
    const response = await withMojaloopSpan("lookup", async () => {
      const res = await fetch(url, {
        method: "GET",
        headers: injectTraceHeaders(this._buildHeaders("GET", url)),
      });
      if (!res.ok) {
        throw new Error(`Party lookup failed: ${res.status} ${await res.text()}`);
      }
      return res;
    });

    const data = await response.json() as any;
    return {
      partyIdType: data.party?.partyIdInfo?.partyIdType,
      partyIdentifier: data.party?.partyIdInfo?.partyIdentifier,
      partyName: data.party?.name,
      fspId: data.party?.partyIdInfo?.fspId,
      supportedCurrencies: data.party?.supportedCurrencies || ["NGN"],
    };
  }

  /**
   * Request a quote for a transfer
   */
  async requestQuote(req: QuoteRequest): Promise<QuoteResponse> {
    const url = `${this.config.switchUrl}/quotes`;
    const body = {
      quoteId: req.quoteId,
      transactionId: req.transactionId,
      payee: {
        partyIdInfo: { partyIdType: req.payeeIdType, partyIdentifier: req.payeeIdentifier, fspId: req.payeeFspId },
      },
      payer: {
        partyIdInfo: { partyIdType: req.payerIdType, partyIdentifier: req.payerIdentifier, fspId: req.payerFspId },
      },
      amountType: "SEND",
      amount: { amount: req.amount, currency: req.currency },
      transactionType: { scenario: req.transactionType, initiator: "PAYER", initiatorType: "CONSUMER" },
      note: req.note,
    };

    const bodyStr = JSON.stringify(body);
    // W35 mojaloop-otel: headers (incl. traceparent) built inside the span;
    // the !ok throw is inside too so the span records ERROR status.
    const response = await withMojaloopSpan("quote", async () => {
      const res = await fetch(url, {
        method: "POST",
        headers: injectTraceHeaders(this._buildHeaders("POST", url, bodyStr)),
        body: bodyStr,
      });
      if (!res.ok) {
        throw new Error(`Quote request failed: ${res.status} ${await res.text()}`);
      }
      return res;
    });

    return response.json() as Promise<QuoteResponse>;
  }

  /**
   * Execute a transfer using a previously obtained quote
   */
  async executeTransfer(req: TransferRequest): Promise<{ transferId: string; fulfilment: string; completedTimestamp: string }> {
    const url = `${this.config.switchUrl}/transfers`;
    const body = {
      transferId: req.transferId,
      payerFsp: req.payerFspId,
      payeeFsp: req.payeeFspId,
      amount: { amount: req.amount, currency: req.currency },
      ilpPacket: req.ilpPacket,
      condition: req.condition,
      expiration: req.expiration,
    };

    const bodyStr = JSON.stringify(body);
    // FSPIOP transfer leg = prepare (POST /transfers); fulfil arrives via callback.
    // W35 mojaloop-otel: headers (incl. traceparent) built inside the span;
    // the !ok throw is inside too so the span records ERROR status.
    const response = await withMojaloopSpan("prepare", async () => {
      const res = await fetch(url, {
        method: "POST",
        headers: injectTraceHeaders(this._buildHeaders("POST", url, bodyStr)),
        body: bodyStr,
      });
      if (!res.ok) {
        throw new Error(`Transfer failed: ${res.status} ${await res.text()}`);
      }
      return res;
    });

    return response.json() as any;
  }

  /**
   * Handle incoming transfer fulfillment callback from the switch
   * Called by the Express webhook route: PUT /api/webhooks/mojaloop/transfers/:id
   */
  handleTransferCallback(transferId: string, body: any): { accepted: boolean; transferId: string } {
    const { transferState, fulfilment } = body;
    const accepted = transferState === "COMMITTED";
    // === W35 mojaloop-otel === fulfil callback span (fail-open).
    try {
      if (isTelemetryActive()) {
        const tracer = trace.getTracer("whatsapp-commerce-mojaloop");
        const span = tracer.startSpan("mojaloop.fulfil", {
          kind: SpanKind.SERVER,
          attributes: {
            "peer.service": "mojaloop",
            "mojaloop.operation": "fulfil",
            "mojaloop.transfer_id": transferId,
            "mojaloop.transfer_state": String(transferState ?? ""),
          },
        });
        span.setStatus({ code: accepted ? SpanStatusCode.OK : SpanStatusCode.ERROR });
        span.end();
      }
    } catch (err) {
      noteTelemetryError("mojaloop-fulfil-span", err);
    }
    // === END W35 mojaloop-otel ===
    return { accepted, transferId };
  }

  /**
   * Build FSPIOP-compliant headers with JWS signature
   */
  private _buildHeaders(method: string, url: string, body?: string): Record<string, string> {
    const date = new Date().toUTCString();
    const headers: Record<string, string> = {
      "Content-Type": "application/vnd.interoperability.transfers+json;version=1.1",
      "Accept": "application/vnd.interoperability.transfers+json;version=1.1",
      "FSPIOP-Source": this.config.fspId,
      "FSPIOP-Date": date,
      "Date": date,
    };

    if (body) {
      // JWS signature over the request body
      const sign = crypto.createSign("SHA256");
      sign.update(body);
      const signature = sign.sign(this.config.jwtSigningKey, "base64");
      headers["FSPIOP-Signature"] = `{"signature":"${signature}","protectedHeader":"eyJhbGciOiJSUzI1NiIsIkZTUElPUC1VUkkiOiIke3VybH0iLCJGU1BJT1AtSFRUUC1NZXRob2QiOiIke21ldGhvZH0iLCJGU1BJT1AtU291cmNlIjoiJHtmc3BJZH0ifQ=="}`;
    }

    return headers;
  }
}

/**
 * Factory: create a Mojaloop adapter from environment variables
 */
export function createMojaloopAdapter(): MojaloopFSPIOPAdapter | null {
  const switchUrl = process.env.MOJALOOP_SWITCH_URL;
  const fspId = process.env.MOJALOOP_FSP_ID;
  const clientCert = process.env.MOJALOOP_CLIENT_CERT || "";
  const clientKey = process.env.MOJALOOP_CLIENT_KEY || "";
  const caCert = process.env.MOJALOOP_CA_CERT || "";
  const jwtSigningKey = process.env.MOJALOOP_JWS_KEY || "";

  if (!switchUrl || !fspId) {
    return null; // Not configured — Mojaloop is optional
  }

  return new MojaloopFSPIOPAdapter({ switchUrl, fspId, clientCert, clientKey, caCert, jwtSigningKey });
}


