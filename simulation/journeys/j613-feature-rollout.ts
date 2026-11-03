/**
 * J613 — Feature rollout: stages and shop exceptions decide what each shop sees, only platform admins
 * can change them, and one shop's exception never reaches another shop.
 */
import { TENANT_ID, assert, type World } from "../world";
import type { Journey } from "../runner";
import { adminCaller, expectTrpcError, tenantCaller } from "./helpers";

const FEATURE = "/group-deals";
const OTHER_TENANT = "sim-rollout-other";

export const journey: Journey = {
  id: "J613",
  name: "feature rollout",
  feature: "Hidden, selected shops and all shops decide what a shop sees, per feature",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    await world.db.insert(schema.tenants).values({ id: OTHER_TENANT, name: "Rollout Other", slug: "sim-rollout-other", status: "active" } as any).onConflictDoNothing();
    const admin = await adminCaller();
    const shop = await tenantCaller(TENANT_ID);
    const other = await tenantCaller(OTHER_TENANT);
    const hiddenFor = async (caller: Awaited<ReturnType<typeof tenantCaller>>) => (await caller.featureRollout.mine()).hidden.includes(FEATURE);

    assert(!(await hiddenFor(shop)), "an undecided feature stays visible");

    await expectTrpcError(shop.featureRollout.setState({ keys: [FEATURE], state: "off" }), "FORBIDDEN", "a shop can't change the rollout");
    await expectTrpcError(shop.featureRollout.overview(), "FORBIDDEN", "a shop can't read the rollout");
    await expectTrpcError(shop.featureRollout.setShopOverride({ tenantId: TENANT_ID, key: FEATURE, enabled: true }), "FORBIDDEN", "a shop can't opt itself in");
    await expectTrpcError(admin.featureRollout.setState({ keys: ["/portal"], state: "off" }), "BAD_REQUEST", "an always-on feature can't be hidden");

    await admin.featureRollout.setState({ keys: [FEATURE], state: "off" });
    assert(await hiddenFor(shop), "hidden from this shop");
    assert(await hiddenFor(other), "hidden from every shop");

    await admin.featureRollout.setState({ keys: [FEATURE], state: "selected" });
    assert(await hiddenFor(shop), "selected: still hidden until a shop is chosen");
    await admin.featureRollout.setShopOverride({ tenantId: TENANT_ID, key: FEATURE, enabled: true });
    const mine = await shop.featureRollout.mine();
    assert(!mine.hidden.includes(FEATURE), "the chosen shop sees it");
    assert(mine.fresh.includes(FEATURE), "the chosen shop gets the New badge");
    assert(await hiddenFor(other), "another shop still doesn't");

    await admin.featureRollout.setState({ keys: [FEATURE], state: "all" });
    assert(!(await hiddenFor(other)), "all shops: everyone sees it");
    await admin.featureRollout.setShopOverride({ tenantId: OTHER_TENANT, key: FEATURE, enabled: false });
    assert(await hiddenFor(other), "a shop can be left out");
    assert(!(await hiddenFor(shop)), "without affecting anyone else");

    await admin.featureRollout.setShopOverride({ tenantId: OTHER_TENANT, key: FEATURE, enabled: null });
    assert(!(await hiddenFor(other)), "clearing the exception follows the stage again");

    await expectTrpcError(admin.featureRollout.setShopOverride({ tenantId: "no-such-shop", key: FEATURE, enabled: true }), "NOT_FOUND", "an unknown shop is refused");

    const overview = await admin.featureRollout.overview();
    assert(overview.rollouts.some((row: any) => row.featureKey === FEATURE && row.state === "all"), "the admin page reads the stage back");

    await admin.featureRollout.setState({ keys: [FEATURE], state: "all" });
    await admin.featureRollout.setShopOverride({ tenantId: TENANT_ID, key: FEATURE, enabled: null });
  },
};
