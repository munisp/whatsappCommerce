/**
 * === W40 tenancy (Coder A, TEN-3) ===
 * J274 — number-hijack scenario blocked at the DATABASE layer. The 0123
 * partial unique indexes are the race-proof backstop behind the router
 * CONFLICT pre-checks (J273):
 *   1. A raw INSERT of a tenant with a whatsappPhoneNumberId already held
 *      by another tenant is rejected by the partial unique index.
 *   2. A raw UPDATE moving a tenant onto someone else's number id fails too.
 *   3. NULL phone number ids are unaffected (multiple unset tenants coexist).
 *   4. The telegram botUsername expression index rejects a case-variant
 *      duplicate written directly in SQL.
 */
import { randomUUID } from "node:crypto";
import { PHONE_NUMBER_ID, assert, type World } from "../world";
import type { Journey } from "../runner";

async function expectPgError(p: Promise<any>, label: string): Promise<void> {
  try {
    await p;
  } catch (e: any) {
    assert(String(e?.message ?? e).toLowerCase().includes("unique"),
      `${label}: rejected with a unique-violation (got ${String(e?.message ?? e).slice(0, 160)})`);
    return;
  }
  throw new Error(`${label}: expected a unique-violation, but the write SUCCEEDED`);
}

export const journey: Journey = {
  id: "J274",
  name: "channel hijack blocked by 0123 unique indexes (TEN-3)",
  feature: "partial unique index on whatsappPhoneNumberId + telegram botUsername expression index; NULLs unaffected",
  async run(world: World) {
    // ── 1. INSERT a second tenant claiming the live sim number id ───────
    await expectPgError(
      world.pg.query(
        `INSERT INTO tenants (id, name, slug, plan, status, "whatsappPhoneNumberId")
         VALUES ($1, $2, $3, 'starter', 'trial', $4)`,
        [`w40-hijack-${randomUUID().slice(0, 8)}`, "Hijack Co", `w40-hijack-${randomUUID().slice(0, 8)}`, PHONE_NUMBER_ID],
      ),
      "duplicate whatsappPhoneNumberId INSERT",
    );

    // ── 2. UPDATE an existing tenant onto the live number id ────────────
    const id2 = `w40-null-${randomUUID().slice(0, 8)}`;
    await world.pg.query(
      `INSERT INTO tenants (id, name, slug, plan, status) VALUES ($1, $2, $3, 'starter', 'trial')`,
      [id2, "Null Number Co", id2],
    );
    await expectPgError(
      world.pg.query(`UPDATE tenants SET "whatsappPhoneNumberId" = $1 WHERE id = $2`, [PHONE_NUMBER_ID, id2]),
      "duplicate whatsappPhoneNumberId UPDATE",
    );

    // ── 3. NULL phone number ids coexist (partial index WHERE clause) ───
    const id3 = `w40-null-${randomUUID().slice(0, 8)}`;
    await world.pg.query(
      `INSERT INTO tenants (id, name, slug, plan, status) VALUES ($1, $2, $3, 'starter', 'trial')`,
      [id3, "Second Null Number Co", id3],
    );
    const nullCount = await world.pg.query(
      `SELECT count(*)::int AS n FROM tenants WHERE "whatsappPhoneNumberId" IS NULL`,
    );
    assert(Number(nullCount.rows?.[0]?.n ?? nullCount[0]?.n) >= 2, "multiple NULL-number tenants coexist");

    // ── 4. Telegram botUsername expression index: case-variant dupe ─────
    const tgA = `w40-tg-${randomUUID().slice(0, 8)}`;
    const tgB = `w40-tg-${randomUUID().slice(0, 8)}`;
    await world.pg.query(
      `INSERT INTO tenants (id, name, slug, plan, status, settings) VALUES ($1, $2, $3, 'starter', 'trial', $4::jsonb)`,
      [tgA, "TG Alpha", tgA, JSON.stringify({ telegram: { botUsername: "SimW40HijackBot", enabled: false } })],
    );
    await expectPgError(
      world.pg.query(
        `INSERT INTO tenants (id, name, slug, plan, status, settings) VALUES ($1, $2, $3, 'starter', 'trial', $4::jsonb)`,
        [tgB, "TG Beta", tgB, JSON.stringify({ telegram: { botUsername: "simw40hijackbot", enabled: false } })],
      ),
      "case-variant telegram botUsername INSERT",
    );

    // Cleanup: remove the scratch tenants (churned status keeps them under
    // the drop guard, but deletion is cleaner for count-based journeys).
    await world.pg.query(`DELETE FROM tenants WHERE id IN ($1, $2, $3, $4)`, [id2, id3, tgA, tgB]);
  },
};
