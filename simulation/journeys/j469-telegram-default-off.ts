/**
 * J469 — Telegram is OFF unless TELEGRAM_ENABLED is exactly "true", and closed tenants leak nothing.
 *
 * J235 proves the per-tenant gates (wrong/missing secret, unknown tenant, tenant with telegram
 * disabled). What nothing proved is the GLOBAL kill switch — the state every deployment starts in
 * (the live cluster runs with it unset). With a fully valid config and the correct secret:
 *   - switch unset → 404 `telegram-disabled`, and NOTHING is processed (no dedupe-ledger claim,
 *     no Bot API call) — so an unconfigured deployment cannot be probed or driven;
 *   - the switch is strict: "TRUE", "1", "yes", "false", "" and " true" do NOT enable it;
 *   - once enabled, the very same request works (the control — proves the 404s were the switch);
 *   - a suspended tenant gets the SAME bare 404 body as an unknown tenant (no status oracle) and
 *     nothing is processed.
 * Mutation-checked: forcing telegramEnabled() to true makes this journey fail (J235/J436 did not).
 */
import { eq } from "drizzle-orm";
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { ensureTelegramConfig, tgPost, tgTextUpdate, TG_SECRET } from "./j235-telegram-webhook-security";

export const journey: Journey = {
  id: "J469",
  name: "telegram is off unless TELEGRAM_ENABLED is exactly true; suspended tenant leaks nothing",
  feature: "W37 telegram: global kill switch + closed-tenant fail-closed",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { tg } = await import("../metaMock");
    const db = world.db;
    const savedEnabled = process.env.TELEGRAM_ENABLED;
    const savedMedia = process.env.TELEGRAM_MEDIA_ENABLED;

    const claimed = async (updateId: number) => {
      const r: any = await world.pg.query(`SELECT id FROM processed_webhook_events WHERE id = $1`, [`tg:${updateId}`]);
      return (r.rows ?? r).length;
    };
    const post = (updateId: number, tenantId = TENANT_ID) =>
      tgPost(world, tenantId, TG_SECRET, tgTextUpdate(updateId, "880469", 770469, "hello"));

    try {
      await ensureTelegramConfig(world); // valid config + correct secret; also sets TELEGRAM_ENABLED=true
      const sendsBefore = tg.callsFor("sendMessage").length;

      // 1. Global switch unset → closed, and nothing happens.
      delete process.env.TELEGRAM_ENABLED;
      const off = await post(969001);
      assert(off.status === 404 && off.json?.error === "telegram-disabled", `switch unset must 404 telegram-disabled, got ${off.status} ${JSON.stringify(off.json)}`);
      await world.settle(150, 300);
      assert((await claimed(969001)) === 0, "a request while the switch is off must NOT claim a dedupe-ledger row");
      assert(tg.callsFor("sendMessage").length === sendsBefore, "a request while the switch is off must NOT reach the Bot API");

      // 2. The switch is strict: only the exact string "true" opens it.
      let id = 969002;
      for (const v of ["TRUE", "1", "yes", "false", "", " true"]) {
        process.env.TELEGRAM_ENABLED = v;
        const r = await post(id);
        assert(r.status === 404 && r.json?.error === "telegram-disabled", `TELEGRAM_ENABLED=${JSON.stringify(v)} must NOT enable telegram (got ${r.status})`);
        assert((await claimed(id)) === 0, `TELEGRAM_ENABLED=${JSON.stringify(v)}: nothing may be claimed`);
        id++;
      }

      // 3. Control: the identical request works once the switch is exactly "true".
      process.env.TELEGRAM_ENABLED = "true";
      const on = await post(969020);
      assert(on.status === 200 && on.json?.received === true, `enabled control must 200, got ${on.status} ${JSON.stringify(on.json)}`);
      assert((await claimed(969020)) === 1, "the enabled request is claimed exactly once");

      // 4. A suspended tenant looks exactly like an unknown one, and nothing is processed.
      const [t] = await db.select({ status: schema.tenants.status }).from(schema.tenants).where(eq(schema.tenants.id, TENANT_ID)).limit(1);
      const priorStatus = t.status;
      await db.update(schema.tenants).set({ status: "suspended" }).where(eq(schema.tenants.id, TENANT_ID));
      try {
        const susp = await post(969030);
        const unknown = await post(969031, "tenant-does-not-exist");
        assert(susp.status === 404 && unknown.status === 404, `suspended and unknown must both 404 (got ${susp.status}/${unknown.status})`);
        assert(JSON.stringify(susp.json) === JSON.stringify(unknown.json), `suspended tenant must be indistinguishable from an unknown one (got ${JSON.stringify(susp.json)} vs ${JSON.stringify(unknown.json)})`);
        assert((await claimed(969030)) === 0, "a suspended tenant's update must NOT be claimed/processed");
      } finally {
        await db.update(schema.tenants).set({ status: priorStatus }).where(eq(schema.tenants.id, TENANT_ID));
      }
      const back = await post(969040);
      assert(back.status === 200, `reactivated tenant works again (got ${back.status})`);
    } finally {
      if (savedEnabled === undefined) delete process.env.TELEGRAM_ENABLED;
      else process.env.TELEGRAM_ENABLED = savedEnabled;
      if (savedMedia === undefined) delete process.env.TELEGRAM_MEDIA_ENABLED;
      else process.env.TELEGRAM_MEDIA_ENABLED = savedMedia;
    }
  },
};
