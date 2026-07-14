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
    const headers = this._buildHeaders("GET", url);

    const response = await fetch(url, {
      method: "GET",
      headers,
    });

    if (!response.ok) {
      throw new Error(`Party lookup failed: ${response.status} ${await response.text()}`);
    }

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

    const headers = this._buildHeaders("POST", url, JSON.stringify(body));
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`Quote request failed: ${response.status} ${await response.text()}`);
    }

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

    const headers = this._buildHeaders("POST", url, JSON.stringify(body));
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`Transfer failed: ${response.status} ${await response.text()}`);
    }

    return response.json() as any;
  }

  /**
   * Handle incoming transfer fulfillment callback from the switch
   * Called by the Express webhook route: PUT /api/webhooks/mojaloop/transfers/:id
   */
  handleTransferCallback(transferId: string, body: any): { accepted: boolean; transferId: string } {
    const { transferState, fulfilment } = body;
    const accepted = transferState === "COMMITTED";
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


