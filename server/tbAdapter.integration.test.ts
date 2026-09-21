/**
 * Runs services/tb-adapter against a REAL TigerBeetle. Skipped unless a cluster is provided:
 *
 *   docker run --rm --security-opt seccomp=unconfined -v tbtest:/data ghcr.io/tigerbeetle/tigerbeetle:0.16.66 \
 *     format --cluster=0 --replica=0 --replica-count=1 --development /data/0_0.tigerbeetle
 *   docker run -d --name tb-test --security-opt seccomp=unconfined -p 3300:3000 -v tbtest:/data \
 *     ghcr.io/tigerbeetle/tigerbeetle:0.16.66 start --addresses=0.0.0.0:3000 --development /data/0_0.tigerbeetle
 *   (cd services/tb-adapter && npm ci)
 *   TB_TEST_ADDRESSES=127.0.0.1:3300 TB_TEST_CLUSTER_ID=0 npx vitest run server/tbAdapter.integration.test.ts
 *
 * Why this exists: rust/ledger-bridge had only ever been tested against an in-memory double that
 * agreed with the bridge about everything — including things a real ledger refuses. Several of
 * these tests document behaviour the double could not have shown:
 *   - the bridge's flag values are not TigerBeetle's (a raw "commit" is executed as a VOID);
 *   - amount 0 does not mean "post everything";
 *   - a transfer rejected once is remembered forever (id_already_failed), so an account has to
 *     exist BEFORE the first attempt;
 *   - transfers between accounts of different ledgers are refused.
 * Ids are random, so the suite is re-runnable against a persistent cluster.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

const ADDRESSES = process.env.TB_TEST_ADDRESSES;
const CLUSTER_ID = process.env.TB_TEST_CLUSTER_ID ?? "0";
const suite = ADDRESSES ? describe : describe.skip;

const ADAPTER_DIR = join(__dirname, "..", "services", "tb-adapter");
const rnd = () => BigInt("0x" + randomBytes(16).toString("hex")) % ((1n << 127n) - 1n) + 1n;
const uuidOf = (v: bigint) => { const h = v.toString(16).padStart(32, "0"); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`; };

let nextPort = 18300 + Math.floor(Math.random() * 500);
async function startAdapter(env: Record<string, string> = {}): Promise<{ url: string; stop: () => void; proc: ChildProcess }> {
  const port = nextPort++;
  const proc = spawn("node", ["server.mjs"], {
    cwd: ADAPTER_DIR,
    env: { ...process.env, PORT: String(port), TB_CLUSTER_ID: CLUSTER_ID, TB_ADDRESSES: ADDRESSES ?? "127.0.0.1:3300", OP_TIMEOUT_MS: "4000", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("adapter did not start")), 10000);
    proc.stdout!.on("data", (d) => { if (String(d).includes('"listening"')) { clearTimeout(t); resolve(); } });
    proc.on("exit", (c) => { clearTimeout(t); reject(new Error(`adapter exited early (${c})`)); });
  });
  return { url: `http://127.0.0.1:${port}/api/v1`, proc, stop: () => proc.kill("SIGTERM") };
}

async function call(base: string, method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: any; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}

suite("tb-adapter against a real TigerBeetle", { timeout: 40000 }, () => {
  let a: Awaited<ReturnType<typeof startAdapter>>;
  let strict: Awaited<ReturnType<typeof startAdapter>>;
  let tbNode: any;
  let raw: any; // direct, un-translated client
  const post = (body: unknown, base = () => a.url) => call(base(), "POST", "/transfers", body);
  const balance = async (id: bigint) => (await call(a.url, "GET", `/accounts/${uuidOf(id)}`)).json;
  const reserve = (id: bigint, d: bigint, c: bigint, amount: number, extra: Record<string, unknown> = {}) =>
    post({ transfers: [{ id: id.toString(), debit_account_id: d.toString(), credit_account_id: c.toString(), amount, ledger: 1, code: 1, flags: 4, timeout: 300, ...extra }] });
  const commit = (id: bigint, pending: bigint, amount = 0) => post({ transfers: [{ id: id.toString(), pending_id: pending.toString(), flags: 8, amount }] });
  const voidIt = (id: bigint, pending: bigint) => post({ transfers: [{ id: id.toString(), pending_id: pending.toString(), flags: 16, amount: 0 }] });

  beforeAll(async () => {
    a = await startAdapter();
    strict = await startAdapter({ AUTO_CREATE_ACCOUNTS: "false" });
    tbNode = createRequire(join(ADAPTER_DIR, "package.json"))("tigerbeetle-node");
    raw = tbNode.createClient({ cluster_id: BigInt(CLUSTER_ID), replica_addresses: [ADDRESSES!.split(",")[0]] });
  });
  afterAll(() => { a?.stop(); strict?.stop(); raw?.destroy(); });

  it("is healthy only because a real round-trip succeeded, and the flag values match the real client", async () => {
    expect((await call(a.url, "GET", "/health")).json).toMatchObject({ status: "ok" });
    expect(tbNode.TransferFlags.pending).toBe(2);
    expect(tbNode.TransferFlags.post_pending_transfer).toBe(4);
    expect(tbNode.TransferFlags.void_pending_transfer).toBe(8);
  });

  it("reserve → commit moves exactly the reserved amount from pending to posted on both accounts", async () => {
    const d = rnd(), c = rnd(), p = rnd();
    expect((await reserve(p, d, c, 5000)).status).toBe(200);
    expect(await balance(d)).toMatchObject({ debits_pending: 5000, debits_posted: 0 });
    expect(await balance(c)).toMatchObject({ credits_pending: 5000, credits_posted: 0 });

    expect((await commit(rnd(), p)).status).toBe(200);
    expect(await balance(d)).toMatchObject({ debits_pending: 0, debits_posted: 5000 });
    expect(await balance(c)).toMatchObject({ credits_pending: 0, credits_posted: 5000 });
  });

  it("reserve → void releases the hold and posts nothing", async () => {
    const d = rnd(), c = rnd(), p = rnd();
    await reserve(p, d, c, 700);
    expect((await voidIt(rnd(), p)).status).toBe(200);
    expect(await balance(d)).toMatchObject({ debits_pending: 0, debits_posted: 0 });
    expect(await balance(c)).toMatchObject({ credits_pending: 0, credits_posted: 0 });
  });

  it("a partial commit posts only that amount and releases the rest of the hold", async () => {
    const d = rnd(), c = rnd(), p = rnd();
    await reserve(p, d, c, 1000);
    expect((await commit(rnd(), p, 300)).status).toBe(200);
    expect(await balance(d)).toMatchObject({ debits_pending: 0, debits_posted: 300 });
  });

  it("single-phase (flags 0) posts immediately", async () => {
    const d = rnd(), c = rnd();
    const r = await post({ transfers: [{ id: rnd().toString(), debit_account_id: d.toString(), credit_account_id: c.toString(), amount: 250, ledger: 1, code: 2, flags: 0, timeout: 0 }] });
    expect(r.status).toBe(200);
    expect(await balance(d)).toMatchObject({ debits_posted: 250, debits_pending: 0 });
  });

  describe("why the translation is not optional (raw, un-translated events sent straight to TigerBeetle)", () => {
    const rawTransfer = (o: Record<string, unknown>) => ({
      id: 0n, debit_account_id: 0n, credit_account_id: 0n, amount: 0n, pending_id: 0n, user_data_128: 0n, user_data_64: 0n,
      user_data_32: 0, timeout: 0, ledger: 0, code: 0, flags: 0, timestamp: 0n, ...o,
    });

    it("the bridge's commit flag (8) is executed by TigerBeetle as a VOID: nothing is ever posted", async () => {
      const d = rnd(), c = rnd(), p = rnd();
      await reserve(p, d, c, 900);
      const errs = await raw.createTransfers([rawTransfer({ id: rnd(), pending_id: p, flags: 8, amount: 0n })]);
      expect(errs).toEqual([]);                                          // TigerBeetle accepted it...
      expect(await balance(d)).toMatchObject({ debits_pending: 0, debits_posted: 0 }); // ...as a void: the money was NOT moved
    });

    it("amount 0 on a post posts NOTHING (and consumes the hold) — hence AMOUNT_MAX in the adapter", async () => {
      const d = rnd(), c = rnd(), p = rnd();
      await reserve(p, d, c, 900);
      const errs = await raw.createTransfers([rawTransfer({ id: rnd(), pending_id: p, flags: tbNode.TransferFlags.post_pending_transfer, amount: 0n })]);
      expect(errs).toEqual([]);
      expect(await balance(d)).toMatchObject({ debits_pending: 0, debits_posted: 0 }); // hold gone, nothing posted
    });

    it("the bridge's void flag (16) is balancing_debit, not a void", async () => {
      expect(tbNode.TransferFlags.balancing_debit).toBe(16);
    });
  });

  it("an identical retry is idempotent (exists → 200); the same pending cannot be committed or voided twice (409)", async () => {
    const d = rnd(), c = rnd(), p = rnd();
    expect((await reserve(p, d, c, 500)).json.results[0].status).toBe("created");
    const again = await reserve(p, d, c, 500);
    expect(again.status).toBe(200);
    expect(again.json.results[0].status).toBe("exists");
    await commit(rnd(), p);
    expect(await commit(rnd(), p)).toMatchObject({ status: 409, json: { error: "pending_transfer_already_posted" } });
    expect(await voidIt(rnd(), p)).toMatchObject({ status: 409 });
    expect(await balance(d)).toMatchObject({ debits_posted: 500 });   // still exactly once
  });

  it("the same id with DIFFERENT contents is refused, not silently accepted", async () => {
    const d = rnd(), c = rnd(), p = rnd();
    await reserve(p, d, c, 500);
    const r = await reserve(p, d, c, 999);
    expect(r.status).toBe(409);
    expect(r.json.error).toBe("exists_with_different_amount");
  });

  it("a commit for a pending that never existed is a 404", async () => {
    expect(await commit(rnd(), rnd())).toMatchObject({ status: 404, json: { error: "pending_transfer_not_found" } });
  });

  it("auto-creates unknown accounts BEFORE the first attempt, in the transfer's own ledger", async () => {
    const d = rnd(), c = rnd();
    expect((await reserve(rnd(), d, c, 100)).status).toBe(200);
    expect(await balance(d)).toMatchObject({ ledger: 1, code: 1000 });
    expect(await balance(c)).toMatchObject({ ledger: 1, code: 1000 });
  });

  it("a transfer rejected once is burned forever (id_already_failed) — which is why accounts must exist first", async () => {
    const d = rnd(), c = rnd(), burned = rnd();
    // Submit straight to TigerBeetle with accounts that do not exist: it rejects AND remembers the id.
    const errs = await raw.createTransfers([{ id: burned, debit_account_id: d, credit_account_id: c, amount: 10n, pending_id: 0n, user_data_128: 0n, user_data_64: 0n, user_data_32: 0, timeout: 0, ledger: 1, code: 1, flags: 0, timestamp: 0n }]);
    expect(tbNode.CreateTransferError[errs[0].result]).toBe("debit_account_not_found");
    // Even after the accounts exist, the same id can never succeed...
    const r = await post({ transfers: [{ id: burned.toString(), debit_account_id: d.toString(), credit_account_id: c.toString(), amount: 10, ledger: 1, code: 1, flags: 0, timeout: 0 }] });
    expect(r).toMatchObject({ status: 409, json: { error: "id_already_failed" } });
    // ...but a fresh id works.
    expect((await post({ transfers: [{ id: rnd().toString(), debit_account_id: d.toString(), credit_account_id: c.toString(), amount: 10, ledger: 1, code: 1, flags: 0, timeout: 0 }] })).status).toBe(200);
  });

  it("strict mode (AUTO_CREATE_ACCOUNTS=false): a missing account is a 404 and the transfer id is NOT burned", async () => {
    const d = rnd(), c = rnd(), id = rnd();
    const body = { transfers: [{ id: id.toString(), debit_account_id: d.toString(), credit_account_id: c.toString(), amount: 40, ledger: 1, code: 1, flags: 0, timeout: 0 }] };
    expect(await post(body, () => strict.url)).toMatchObject({ status: 404, json: { error: "account_not_found" } });
    for (const acct of [d, c]) {
      expect((await call(strict.url, "POST", "/accounts", { accounts: [{ id: acct.toString(), ledger: 1, code: 1000, flags: 0 }] })).status).toBe(200);
    }
    expect((await post(body, () => strict.url)).status).toBe(200);    // same id, now succeeds
  });

  it("accounts of different ledgers cannot exchange money", async () => {
    const d = rnd(), c = rnd();
    await reserve(rnd(), d, c, 10);                                  // both live in ledger 1
    const r = await reserve(rnd(), d, c, 10, { ledger: 2 });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.json.error).toMatch(/ledger/);
  });

  it("creating an account twice is idempotent", async () => {
    const id = rnd();
    const body = { accounts: [{ id: id.toString(), ledger: 1, code: 1000, flags: 0 }] };
    expect((await call(a.url, "POST", "/accounts", body)).json.results[0].status).toBe("created");
    expect((await call(a.url, "POST", "/accounts", body)).json.results[0].status).toBe("exists");
  });

  it("a hold with a timeout expires by itself: the money is released and the pending can no longer be committed", async () => {
    const d = rnd(), c = rnd(), p = rnd();
    await reserve(p, d, c, 800, { timeout: 1 });
    expect(await balance(d)).toMatchObject({ debits_pending: 800 });
    await new Promise((r) => setTimeout(r, 2500));
    const r = await commit(rnd(), p);
    expect(r).toMatchObject({ status: 409, json: { error: "pending_transfer_expired" } });
    expect(await balance(d)).toMatchObject({ debits_pending: 0, debits_posted: 0 });
  });

  it("concurrent reserves on brand-new accounts all succeed and the pending total is exact (no lost or doubled holds)", async () => {
    const d = rnd(), c = rnd();
    const rs = await Promise.all(Array.from({ length: 25 }, () => reserve(rnd(), d, c, 10)));
    expect(rs.map((r) => r.status)).toEqual(Array(25).fill(200));
    expect(await balance(d)).toMatchObject({ debits_pending: 250 });
    expect(await balance(c)).toMatchObject({ credits_pending: 250 });
  });

  it("concurrent identical retries create exactly one hold", async () => {
    const d = rnd(), c = rnd(), p = rnd();
    const rs = await Promise.all(Array.from({ length: 10 }, () => reserve(p, d, c, 77)));
    expect(rs.every((r) => r.status === 200)).toBe(true);
    expect(rs.filter((r) => r.json.results[0].status === "created")).toHaveLength(1);
    expect(await balance(d)).toMatchObject({ debits_pending: 77 });
  });

  it("refuses bad input without touching the ledger", async () => {
    const malformed = await fetch(a.url + "/transfers", { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" });
    expect(malformed.status).toBe(400);
    expect((await call(a.url, "POST", "/transfers", "a valid json string, but not a request")).status).toBe(422);
    expect((await post({ transfers: [{ id: "5", debit_account_id: "1", credit_account_id: "2", amount: 1.5, ledger: 1, code: 1, flags: 4 }] })).status).toBe(422);
    expect((await post({ transfers: [{ id: "5", debit_account_id: "1", credit_account_id: "2", amount: 5, ledger: 1, code: 1, flags: 2 }] })).status).toBe(422); // TigerBeetle-native flag is not part of the contract
    expect((await call(a.url, "GET", "/accounts/not-an-id")).status).toBe(422);
    expect((await call(a.url, "GET", `/accounts/${uuidOf(rnd())}`)).status).toBe(404);
    expect((await call(a.url, "GET", "/nope")).status).toBe(404);
    const big = await fetch(a.url + "/transfers", { method: "POST", body: "x".repeat(70 * 1024) }).then((r) => r.status).catch(() => 413);
    expect([413, 400]).toContain(big);
  });

  it("when TigerBeetle cannot be reached it answers 503 promptly instead of hanging (bounded by OP_TIMEOUT_MS)", async () => {
    const dead = await startAdapter({ TB_ADDRESSES: "127.0.0.1:1", OP_TIMEOUT_MS: "1500" });
    try {
      const t0 = Date.now();
      const h = await call(dead.url, "GET", "/health");
      expect(h.status).toBe(503);
      expect(Date.now() - t0).toBeLessThan(3500);
      const t1 = Date.now();
      const r = await call(dead.url, "POST", "/transfers", { transfers: [{ id: "5", debit_account_id: "1", credit_account_id: "2", amount: 5, ledger: 1, code: 1, flags: 4 }] });
      expect(r.status).toBe(503);
      expect(r.json.error).toBe("tigerbeetle_unavailable");
      expect(Date.now() - t1).toBeLessThan(3500);
    } finally { dead.stop(); }
  });
});
