/**
 * TigerBeetle HTTP sidecar — IN-MEMORY TEST DOUBLE.
 *
 * Implements the exact HTTP contract that rust/ledger-bridge's TigerBeetleClient
 * (rust/ledger-bridge/src/main.rs) targets when it talks to
 * http://<TIGERBEETLE_ADDRESS>/api/v1:
 *
 *   GET  /api/v1/health          — used by TigerBeetleClient.health()
 *   POST /api/v1/accounts        — {cluster_id, accounts:[{id, ledger, code, flags, ...}]}
 *   POST /api/v1/transfers       — {cluster_id, transfers:[{...}]}
 *   GET  /api/v1/accounts/:id    — {debits_pending, debits_posted, credits_pending, credits_posted}
 *
 * Transfer flag semantics, copied from the bridge source (NOT from real
 * TigerBeetle — the bridge uses its own bit values):
 *   flags = 0   single-phase POSTED transfer (debits_posted/credits_posted move now)
 *   flags = 4   PENDING transfer — reserve: debit.debits_pending += amount,
 *               credit.credits_pending += amount (create_pending_transfer)
 *   flags = 8   POST pending transfer — commit: pending → posted for the
 *               transfer referenced by pending_id (post_pending_transfer)
 *   flags = 16  VOID pending transfer — release the reservation referenced by
 *               pending_id (void_pending_transfer)
 *
 * Account ids are TigerBeetle u128s which arrive as decimal strings, 32-char
 * hex strings, or canonical UUIDs depending on the caller — all forms are
 * normalised to the decimal u128 string key.
 *
 * Test-only extras (not part of the bridge contract):
 *   POST /api/v1/seed {account_id, amount_minor} — fund an account with a
 *     posted credit so tests can set up solvent accounts.
 *   GET  /api/v1/state — dump all accounts + transfers (debugging).
 *
 * Dependency-free (node:http only). Unknown accounts referenced by a transfer
 * are auto-vivified with zero balances — this is a permissive double, not a
 * validating replica of TigerBeetle's state machine.
 */
import http from "node:http";

const PORT = Number(process.env.PORT ?? 3000);

/** Normalise any accepted u128 representation to its decimal string. */
function normId(raw) {
  const s = String(raw ?? "").trim();
  if (!s) throw new Error("empty account id");
  if (/^\d+$/.test(s)) return BigInt(s).toString(); // decimal u128
  if (/^[0-9a-fA-F]{32}$/.test(s)) return BigInt(`0x${s}`).toString(); // 32-char hex
  const uuid = s.match(/^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$/);
  if (uuid) return BigInt(`0x${s.replaceAll("-", "")}`).toString(); // canonical UUID
  throw new Error(`unparseable account id: ${s}`);
}

/** @type {Map<string, {id:string, ledger:number, code:number, debitsPending:number, debitsPosted:number, creditsPending:number, creditsPosted:number}>} */
const accounts = new Map();
/** @type {Map<string, {id:string, debit:string, credit:string, amount:number, ledger:number, code:number, status:"pending"|"posted"|"voided", timeout:number}>} */
const transfers = new Map();

function getOrCreateAccount(idDecimal, ledger = 0, code = 0) {
  let acct = accounts.get(idDecimal);
  if (!acct) {
    acct = {
      id: idDecimal, ledger, code,
      debitsPending: 0, debitsPosted: 0, creditsPending: 0, creditsPosted: 0,
    };
    accounts.set(idDecimal, acct);
  }
  return acct;
}

function accountView(a) {
  return {
    id: a.id,
    ledger: a.ledger,
    code: a.code,
    debits_pending: a.debitsPending,
    debits_posted: a.debitsPosted,
    credits_pending: a.creditsPending,
    credits_posted: a.creditsPosted,
  };
}

function createAccounts(list) {
  const results = [];
  for (const raw of list) {
    const id = normId(raw.id);
    const existing = accounts.get(id);
    if (!existing) {
      getOrCreateAccount(id, Number(raw.ledger ?? 0), Number(raw.code ?? 0));
      results.push({ id, result: "ok" });
    } else {
      results.push({ id, result: "exists" });
    }
  }
  return results;
}

function applyTransfer(t) {
  const id = String(t.id ?? "");
  if (!id) throw new Error("transfer missing id");
  const dupe = transfers.get(id);
  if (dupe) return { id, result: "exists", status: dupe.status }; // idempotent replay

  const flags = Number(t.flags ?? 0);
  const amount = Number(t.amount ?? 0);

  if (flags === 8 || flags === 16) {
    // post_pending_transfer / void_pending_transfer — resolve via pending_id.
    const pendingId = String(t.pending_id ?? "");
    const pending = transfers.get(pendingId);
    if (!pending) return { id, result: "pending_transfer_not_found" };
    if (pending.status !== "pending") return { id, result: `pending_transfer_already_${pending.status}` };
    const debit = getOrCreateAccount(pending.debit);
    const credit = getOrCreateAccount(pending.credit);
    const amt = amount > 0 ? amount : pending.amount; // 0 = full amount
    if (flags === 8) {
      debit.debitsPending -= pending.amount;
      credit.creditsPending -= pending.amount;
      debit.debitsPosted += amt;
      credit.creditsPosted += amt;
      pending.status = "posted";
    } else {
      debit.debitsPending -= pending.amount;
      credit.creditsPending -= pending.amount;
      pending.status = "voided";
    }
    transfers.set(id, {
      id, debit: pending.debit, credit: pending.credit, amount: amt,
      ledger: pending.ledger, code: pending.code,
      status: flags === 8 ? "posted" : "voided", timeout: 0,
    });
    return { id, result: "ok", status: transfers.get(id).status };
  }

  if (flags !== 0 && flags !== 4) {
    return { id, result: `unsupported_flags_${flags}` };
  }

  const debitId = normId(t.debit_account_id);
  const creditId = normId(t.credit_account_id);
  const debit = getOrCreateAccount(debitId, Number(t.ledger ?? 0), Number(t.code ?? 0));
  const credit = getOrCreateAccount(creditId, Number(t.ledger ?? 0), Number(t.code ?? 0));

  if (flags === 4) {
    // pending (reserve) — moves the pending buckets only.
    debit.debitsPending += amount;
    credit.creditsPending += amount;
    transfers.set(id, {
      id, debit: debitId, credit: creditId, amount,
      ledger: Number(t.ledger ?? 0), code: Number(t.code ?? 0),
      status: "pending", timeout: Number(t.timeout ?? 0),
    });
    return { id, result: "ok", status: "pending" };
  }

  // flags === 0 — single-phase posted transfer.
  debit.debitsPosted += amount;
  credit.creditsPosted += amount;
  transfers.set(id, {
    id, debit: debitId, credit: creditId, amount,
    ledger: Number(t.ledger ?? 0), code: Number(t.code ?? 0),
    status: "posted", timeout: 0,
  });
  return { id, result: "ok", status: "posted" };
}

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(json) });
  res.end(json);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const path = url.pathname;

  if (req.method === "GET" && path === "/api/v1/health") {
    return send(res, 200, {
      status: "ok",
      service: "tb-sidecar",
      accounts: accounts.size,
      transfers: transfers.size,
    });
  }

  if (req.method === "GET" && path === "/api/v1/state") {
    return send(res, 200, {
      accounts: [...accounts.values()].map(accountView),
      transfers: [...transfers.values()],
    });
  }

  const acctMatch = req.method === "GET" && path.match(/^\/api\/v1\/accounts\/([^/]+)$/);
  if (acctMatch) {
    let id;
    try {
      id = normId(decodeURIComponent(acctMatch[1]));
    } catch {
      return send(res, 400, { error: "invalid_account_id" });
    }
    const acct = accounts.get(id);
    if (!acct) return send(res, 404, { error: "account_not_found", id });
    return send(res, 200, accountView(acct));
  }

  if (req.method === "POST" && (path === "/api/v1/accounts" || path === "/api/v1/transfers" || path === "/api/v1/seed")) {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      } catch {
        return send(res, 400, { error: "invalid_json" });
      }
      try {
        if (path === "/api/v1/accounts") {
          return send(res, 200, { results: createAccounts(body.accounts ?? []) });
        }
        if (path === "/api/v1/seed") {
          const id = normId(body.account_id);
          const acct = getOrCreateAccount(id);
          acct.creditsPosted += Number(body.amount_minor ?? 0);
          return send(res, 200, { seeded: true, account: accountView(acct) });
        }
        // /api/v1/transfers
        const results = (body.transfers ?? []).map((t) => {
          try {
            return applyTransfer(t);
          } catch (e) {
            return { id: String(t?.id ?? ""), result: "error", detail: String(e?.message ?? e) };
          }
        });
        return send(res, 200, { results });
      } catch (e) {
        return send(res, 400, { error: "bad_request", detail: String(e?.message ?? e) });
      }
    });
    return;
  }

  send(res, 404, { error: "not_found", path });
});

server.listen(PORT, () => {
  console.log(`[tb-sidecar] listening on :${PORT} (in-memory TigerBeetle HTTP double)`);
});
