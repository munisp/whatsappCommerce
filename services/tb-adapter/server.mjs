/**
 * TigerBeetle HTTP adapter — the "TigerBeetle HTTP sidecar" that rust/ledger-bridge has always
 * assumed but that did not exist anywhere in this repo (only an in-memory test double did:
 * tests/e2e/fixtures/tb-sidecar.mjs). It implements the same /api/v1 contract, backed by a
 * real cluster through the official client:
 *
 *   GET  /api/v1/health          200 only if a real round-trip to TigerBeetle succeeds, else 503
 *   POST /api/v1/accounts        {accounts:[{id, ledger, code, flags:0}]}
 *   POST /api/v1/transfers       {transfers:[{id, debit_account_id, credit_account_id, amount,
 *                                 ledger, code, flags: 0|4|8|16, timeout, pending_id}]}
 *   GET  /api/v1/accounts/:id    {debits_pending, debits_posted, credits_pending, credits_posted}
 *
 * Configuration (environment):
 *   TB_CLUSTER_ID        required, decimal u128 (the cluster's real id; the bridge's own
 *                        cluster_id field is a u32 and is ignored)
 *   TB_ADDRESSES         required, comma-separated host:port. Hostnames are resolved to IPv4 on
 *                        every (re)connect because TigerBeetle clients need IPs and a restarted
 *                        replica gets a new one.
 *   HOST / PORT          default 127.0.0.1:3000 — it is a sidecar, so it listens on loopback only
 *   OP_TIMEOUT_MS        default 4000 (must stay below the bridge's 5 s HTTP timeout)
 *   AUTO_CREATE_ACCOUNTS default true: before a transfer is submitted, any account it names that
 *                        TigerBeetle has never seen is created in the transfer's ledger, with the
 *                        flags and code its kind implies (translate.mjs ACCOUNT_KINDS: escrow and
 *                        merchant accounts cannot be overdrawn). This is the behaviour the e2e suite has always been
 *                        validated against, and it is required today because the server derives
 *                        transfer account ids that nothing provisions (see docs/RESILIENCE.md
 *                        "Ledger wiring"). Set false to be strict: a missing account is then a
 *                        404 and the transfer is never submitted.
 */
import http from "node:http";
import dns from "node:dns/promises";
import net from "node:net";
import { createClient, TransferFlags, AccountFlags, CreateTransferError, CreateAccountError } from "tigerbeetle-node";
import {
  HttpError, TB, TB_ACCOUNT, parseId, toTbTransfer, toTbAccount, classifyResult, balanceNumber, accountPolicyForId,
} from "./translate.mjs";

// Fail fast if a client upgrade ever changes the flag values translate.mjs depends on.
if (TransferFlags.pending !== TB.PENDING || TransferFlags.post_pending_transfer !== TB.POST_PENDING || TransferFlags.void_pending_transfer !== TB.VOID_PENDING) {
  throw new Error("tigerbeetle-node TransferFlags no longer match translate.mjs — refusing to start");
}
if (AccountFlags.debits_must_not_exceed_credits !== TB_ACCOUNT.DEBITS_MUST_NOT_EXCEED_CREDITS) {
  throw new Error("tigerbeetle-node AccountFlags no longer match translate.mjs — refusing to start");
}

const cfg = {
  host: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 3000),
  clusterId: process.env.TB_CLUSTER_ID,
  addresses: (process.env.TB_ADDRESSES ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  opTimeoutMs: Number(process.env.OP_TIMEOUT_MS ?? 4000),
  autoCreate: (process.env.AUTO_CREATE_ACCOUNTS ?? "true") !== "false",
};

const log = (level, msg, extra = {}) => console.log(JSON.stringify({ ts: new Date().toISOString(), level, service: "tb-http-adapter", msg, ...extra }));

if (!cfg.clusterId || !/^\d+$/.test(cfg.clusterId)) throw new Error("TB_CLUSTER_ID must be a decimal u128");
if (cfg.addresses.length === 0) throw new Error("TB_ADDRESSES must list at least one host:port");
const CLUSTER_ID = BigInt(cfg.clusterId);

// ── client lifecycle ─────────────────────────────────────────────────────────

let client = null;

async function resolveAddresses() {
  return Promise.all(cfg.addresses.map(async (a) => {
    const i = a.lastIndexOf(":");
    const host = a.slice(0, i), port = a.slice(i + 1);
    if (!host || !/^\d+$/.test(port)) throw new Error(`bad TB address ${JSON.stringify(a)} (want host:port)`);
    if (net.isIPv4(host)) return `${host}:${port}`;
    const { address } = await dns.lookup(host, { family: 4 });
    return `${address}:${port}`;
  }));
}

async function getClient() {
  if (client) return client;
  const replica_addresses = await resolveAddresses();
  client = createClient({ cluster_id: CLUSTER_ID, replica_addresses });
  log("info", "tigerbeetle client created", { replica_addresses });
  return client;
}

function resetClient(reason) {
  if (!client) return;
  try { client.destroy(); } catch { /* already gone */ }
  client = null;
  knownAccounts.clear();
  log("warn", "tigerbeetle client reset", { reason });
}

/** Every TigerBeetle call is bounded: the native client retries forever and would never fail on its own. */
async function tb(op) {
  let c;
  try {
    c = await getClient();
  } catch (e) {
    throw new HttpError(503, "tigerbeetle_unavailable", `cannot resolve TigerBeetle: ${e.message}`);
  }
  let timer;
  try {
    return await Promise.race([
      op(c),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new HttpError(503, "tigerbeetle_unavailable", `no reply within ${cfg.opTimeoutMs} ms`)), cfg.opTimeoutMs); }),
    ]);
  } catch (e) {
    if (e instanceof HttpError && e.status === 503) resetClient(e.message);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// ── handlers ─────────────────────────────────────────────────────────────────

const accountErrorName = (code) => CreateAccountError[code] ?? `unknown_${code}`;
const transferErrorName = (code) => CreateTransferError[code] ?? `unknown_${code}`;

async function createAccount(acct) {
  const [err] = await tb((c) => c.createAccounts([acct]));
  const name = err ? accountErrorName(err.result) : "ok";
  const { kind, status } = classifyResult(name);
  if (kind === "ok") return { status: "created" };
  if (kind === "exists") return { status: "exists" };
  throw new HttpError(status, name, `create_account: ${name}`);
}

async function handleAccounts(body) {
  const list = Array.isArray(body?.accounts) ? body.accounts : null;
  if (!list || list.length === 0) throw new HttpError(422, "invalid_request", "accounts[] is required");
  const results = [];
  for (const [index, raw] of list.entries()) {
    const acct = toTbAccount(raw);
    results.push({ index, id: acct.id.toString(), ...(await createAccount(acct)) });
  }
  return { ok: true, results };
}

async function createTransferOnce(transfer) {
  const [err] = await tb((c) => c.createTransfers([transfer]));
  return err ? transferErrorName(err.result) : "ok";
}

// Accounts are never deleted in TigerBeetle, so once seen they are cached (cleared with the client).
const knownAccounts = new Set();

/**
 * Make sure both accounts exist BEFORE a transfer is submitted. This cannot be "try, create what
 * was missing, retry": TigerBeetle remembers failed transfer ids (id_already_failed), so a
 * transfer rejected once because an account was missing could never be retried under the same
 * id — and the bridge derives ids deterministically from the idempotency key.
 */
async function ensureAccounts(ids, ledger) {
  const need = [...new Set(ids)].filter((id) => !knownAccounts.has(id));
  if (need.length === 0) return;
  const found = await tb((c) => c.lookupAccounts(need));
  const seen = new Set(found.map((a) => a.id));
  for (const id of seen) knownAccounts.add(id);
  for (const id of need) {
    if (seen.has(id)) continue;
    if (!cfg.autoCreate) throw new HttpError(404, "account_not_found", `account ${id} does not exist (AUTO_CREATE_ACCOUNTS=false)`);
    // The kind stamped into the id (services/ledgerAccounts.ts on the server) decides the account's
    // flags: escrow/merchant accounts get debits_must_not_exceed_credits, so the ledger itself refuses
    // an overdraft. Untagged ids (anything else) are created plain.
    const policy = accountPolicyForId(id);
    await createAccount({
      id, debits_pending: 0n, debits_posted: 0n, credits_pending: 0n, credits_posted: 0n,
      user_data_128: 0n, user_data_64: 0n, user_data_32: 0, reserved: 0,
      ledger, code: policy.code, flags: policy.flags, timestamp: 0n,
    });
    knownAccounts.add(id);
    log("info", "auto-created ledger account", { account_id: id.toString(), ledger, kind: policy.kind, overdraft_protected: policy.flags !== 0 });
  }
}

async function handleTransfers(body) {
  const list = Array.isArray(body?.transfers) ? body.transfers : null;
  if (!list || list.length === 0) throw new HttpError(422, "invalid_request", "transfers[] is required");
  const results = [];
  for (const [index, raw] of list.entries()) {
    const { transfer, kind } = toTbTransfer(raw);
    if (kind === "posted" || kind === "pending") await ensureAccounts([transfer.debit_account_id, transfer.credit_account_id], transfer.ledger);
    const name = await createTransferOnce(transfer);
    const c = classifyResult(name);
    if (c.kind === "ok") results.push({ index, id: transfer.id.toString(), status: "created" });
    else if (c.kind === "exists") results.push({ index, id: transfer.id.toString(), status: "exists" });
    else throw new HttpError(c.status, name, `create_transfer[${index}] (${kind}): ${name}`);
  }
  return { ok: true, results };
}

async function handleGetAccount(rawId) {
  const id = parseId(decodeURIComponent(rawId), "account id");
  const [a] = await tb((c) => c.lookupAccounts([id]));
  if (!a) throw new HttpError(404, "account_not_found", `account ${id} not found`);
  return {
    id: a.id.toString(), ledger: a.ledger, code: a.code,
    debits_pending: balanceNumber(a.debits_pending, "debits_pending"),
    debits_posted: balanceNumber(a.debits_posted, "debits_posted"),
    credits_pending: balanceNumber(a.credits_pending, "credits_pending"),
    credits_posted: balanceNumber(a.credits_posted, "credits_posted"),
  };
}

const U128_MAX_MINUS_ONE = (1n << 128n) - 2n;
async function handleHealth() {
  // A real request/reply, not "the socket is open": ask TigerBeetle for an id that cannot exist.
  await tb((c) => c.lookupAccounts([U128_MAX_MINUS_ONE]));
  return { status: "ok", service: "tb-http-adapter" };
}


// ── http plumbing ────────────────────────────────────────────────────────────

const MAX_BODY = 64 * 1024;

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (d) => {
      size += d.length;
      if (size > MAX_BODY) { reject(new HttpError(413, "payload_too_large", "body exceeds 64 KiB")); req.destroy(); return; }
      chunks.push(d);
    });
    req.on("end", () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); }
      catch { reject(new HttpError(400, "invalid_json", "request body is not valid JSON")); }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const t0 = Date.now();
  const path = (req.url ?? "").split("?")[0];
  let status = 500, payload;
  try {
    if (req.method === "GET" && path === "/api/v1/health") payload = await handleHealth();
    else if (req.method === "POST" && path === "/api/v1/accounts") payload = await handleAccounts(await readJson(req));
    else if (req.method === "POST" && path === "/api/v1/transfers") payload = await handleTransfers(await readJson(req));
    else if (req.method === "GET" && /^\/api\/v1\/accounts\/[^/]+$/.test(path)) payload = await handleGetAccount(path.split("/").pop());
    else throw new HttpError(404, "not_found", `${req.method} ${path}`);
    status = 200;
  } catch (e) {
    if (e instanceof HttpError) { status = e.status; payload = { ok: false, error: e.code, message: e.message }; }
    else { status = 500; payload = { ok: false, error: "internal_error", message: String(e?.message ?? e) }; log("error", "unhandled", { path, err: String(e?.stack ?? e) }); }
  }
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
  if (!(path === "/api/v1/health" && status === 200)) log(status >= 500 ? "error" : "info", "request", { method: req.method, path, status, ms: Date.now() - t0, ...(status >= 400 ? { error: payload.error } : {}) });
});

server.listen(cfg.port, cfg.host, () => log("info", "listening", { host: cfg.host, port: cfg.port, cluster_id: cfg.clusterId, addresses: cfg.addresses, autoCreateAccounts: cfg.autoCreate }));

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => { log("info", "shutting down", { sig }); server.close(() => { resetClient("shutdown"); process.exit(0); }); setTimeout(() => process.exit(0), 3000).unref(); });
}
