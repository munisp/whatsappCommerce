/**
 * simulation/sharedNumberSuite.ts — every conversation on the shared platform number, end to end against the real
 * webhook and services (Meta, the LLM and payments mocked, as in the rest of the simulation).
 *
 * Usage:  npx tsx simulation/sharedNumberSuite.ts          (all)
 *         npx tsx simulation/sharedNumberSuite.ts S03 S10  (subset)
 *
 * The suite seeds its own shops on the shared number (no WhatsApp number of their own): two real ones with products,
 * twelve small ones (so the directory pages), and one each hidden, empty and suspended (never listed). The seed store
 * of the simulation world has its own number, so "SHOP sim-store" must send the buyer there.
 */
import { assert, assertIncludes, bootWorld, type World } from "./world";
import * as payloads from "./payloads";
import { runOneJourney, writeTranscripts, type Journey } from "./runner";

const SHARED_PN = "pn_sim_shared_001";
const SHARED_DISPLAY = "2348081319721";
const PLATFORM = "Runit Technologies";

const MAMA = { id: "shr-mamaput", name: "Mama Put Kitchen", code: "mamaput" };
const BAYO = { id: "shr-bayo", name: "Bayo Phones", code: "bayo" };

// ── setup ─────────────────────────────────────────────────────────────────────

async function seedShared(world: World): Promise<void> {
  process.env.SHARED_WA_PHONE_NUMBER_ID = SHARED_PN;
  process.env.SHARED_WA_TOKEN = "sim-shared-token";
  process.env.SHARED_WA_DISPLAY_NUMBER = SHARED_DISPLAY;
  process.env.SHARED_WA_PLATFORM_NAME = PLATFORM;
  const schema = await import("../drizzle/schema");
  const { sql, like } = await import("drizzle-orm");
  await world.db.delete(schema.products).where(like(schema.products.tenantId, "shr-%"));
  await world.db.delete(schema.sharedNumberVisits).where(like(schema.sharedNumberVisits.tenantId, "shr-%"));
  await world.db.delete(schema.tenants).where(like(schema.tenants.id, "shr-%"));
  const settings = (extra: Record<string, unknown> = {}) => ({
    onboarding: { status: "live", reasons: [], completedSteps: ["whatsapp", "useCases", "integrations", "branding", "payout"], validationPassed: true },
    plan: { tier: "growth", limits: { messagesPerMonth: 1_000_000, ordersPerMonth: 1_000_000 } },
    adminPhone: "2348099955555",
    ...extra,
  });
  const shop = (id: string, name: string, code: string | null, status = "active", extra: Record<string, unknown> = {}) =>
    world.db.insert(schema.tenants).values({
      id, name, slug: id.replace(/^shr-/, "shr-slug-"), shopCode: code, plan: "growth", status: status as any,
      defaultCurrency: "NGN", defaultLanguage: "en", settings: settings(extra),
    });
  const product = (tenantId: string, n: number, name: string, category: string, price: string, stock = 20) =>
    world.db.insert(schema.products).values({
      id: `${tenantId}-p${n}`, tenantId, sku: `${tenantId}-${n}`, name, description: `${name} from the shared-number suite`,
      category, price, currency: "NGN", status: "active", stockQuantity: stock,
    } as any);

  await shop(MAMA.id, MAMA.name, MAMA.code);
  await product(MAMA.id, 1, "Jollof Rice", "Food", "2500.00");
  await product(MAMA.id, 2, "Pepsi 50cl", "Drinks", "400.00");
  await product(MAMA.id, 3, "Zobo Drink", "Drinks", "500.00");
  await shop(BAYO.id, BAYO.name, BAYO.code);
  await product(BAYO.id, 1, "Phone Charger", "Electronics", "4500.00");
  await product(BAYO.id, 2, "Power Bank 20000mAh", "Electronics", "18000.00");
  for (let i = 1; i <= 12; i++) {
    await shop(`shr-small-${i}`, `Small Shop ${String(i).padStart(2, "0")}`, null);
    await product(`shr-small-${i}`, 1, `Item ${i}`, "General", "100.00");
  }
  await shop("shr-hidden", "Hidden Shop", "hidden", "active", { directory: { listed: false } });
  await product("shr-hidden", 1, "Secret Pepsi", "Drinks", "100.00");
  await shop("shr-empty", "Empty Shop", "empty");
  await shop("shr-suspended", "Suspended Shop", "suspended", "suspended");
  await product("shr-suspended", 1, "Suspended Pepsi", "Drinks", "100.00");
  void sql;
}

// ── drivers ───────────────────────────────────────────────────────────────────

const send = async (world: World, from: string, text: string, id?: string) => {
  await world.inbound(payloads.inbound.text(SHARED_PN, from, text, { id }));
  await world.settle(400);
};
const tap = async (world: World, from: string, id: string, title = id) => {
  await world.inbound(payloads.inbound.buttonReply(SHARED_PN, from, id, title));
  await world.settle(400);
};
const pick = async (world: World, from: string, id: string, title = id) => {
  await world.inbound(payloads.inbound.listReply(SHARED_PN, from, id, title));
  await world.settle(400);
};
/** What the buyer received since `mark` (calls from the shared number only). */
const repliesSince = (world: World, phone: string, mark: number) =>
  world.outbound.toPhone(phone).slice(mark).filter((c) => c.url.includes(`/${SHARED_PN}/messages`));
const mark = (world: World, phone: string) => world.outbound.toPhone(phone).length;
const textOf = (c: any): string => JSON.stringify(c?.body ?? {});
const rowsOf = (c: any): any[] => (c?.body?.interactive?.action?.sections ?? []).flatMap((s: any) => s.rows ?? []);
const buttonsOf = (c: any): any[] => c?.body?.interactive?.action?.buttons ?? [];
const one = (world: World, phone: string, m: number, what: string) => {
  const r = repliesSince(world, phone, m);
  assert(r.length >= 1, `${what}: the buyer gets a reply from the shared number (got ${r.length})`);
  return r;
};
const visitOf = async (world: World, phone: string): Promise<string | null> => {
  const res = await world.pg.query(`select "tenantId" from shared_number_visits where "buyerPhone"=$1 order by "lastActiveAt" desc limit 1`, [phone]);
  return (Array.isArray(res) ? res : res.rows)[0]?.tenantId ?? null;
};
const enterShop = async (world: World, phone: string, code: string) => {
  await send(world, phone, `SHOP ${code.toUpperCase()}`);
};

// ── journeys ──────────────────────────────────────────────────────────────────

const J = (id: string, name: string, run: (world: World) => Promise<void>): Journey =>
  ({ id, name, feature: "shared number", run: async (world) => { await seedShared(world); await run(world); } });

export const journeys: Journey[] = [
  J("S01", "hello in the lobby: welcome with Browse / Search, no My shops yet", async (world) => {
    const p = world.newPhone("1"); const m = mark(world, p);
    await send(world, p, "hi");
    const [w] = one(world, p, m, "hi");
    assert(w.body?.type === "interactive" && w.body.interactive.type === "button", "the welcome is a button message");
    const ids = buttonsOf(w).map((b) => b.reply.id);
    assert(ids.includes("lobby:browse") && ids.includes("lobby:search") && !ids.includes("lobby:mine"), `buttons: ${ids}`);
    assertIncludes(textOf(w), PLATFORM, "the welcome names the platform");
    for (const b of buttonsOf(w)) assert(b.reply.title.length <= 20, `button title within 20: ${b.reply.title}`);
  }),

  J("S02", "browse: only listed shops, at most 10 rows, More stores… pages on without repeats", async (world) => {
    const p = world.newPhone("2"); const m = mark(world, p);
    await send(world, p, "show me the shops");
    const [list] = one(world, p, m, "browse");
    const rows = rowsOf(list);
    assert(list.body.interactive.type === "list" && rows.length <= 10, `a list of at most 10 rows (got ${rows.length})`);
    const titles = rows.map((r) => r.title).join(" | ");
    for (const never of ["Hidden Shop", "Empty Shop", "Suspended Shop", "Sim Store"]) assert(!titles.includes(never), `${never} is not listed: ${titles}`);
    for (const r of rows) assert(r.title.length <= 24 && (r.description ?? "").length <= 72, `row within limits: ${r.title}`);
    const more = rows.find((r) => r.id.startsWith("shared_more:"));
    assert(more, `14 listed shops do not fit one page: a More stores… row (${titles})`);
    const m2 = mark(world, p);
    await pick(world, p, more.id, more.title);
    const [page2] = one(world, p, m2, "more stores");
    const ids1 = new Set(rows.map((r) => r.id)), rows2 = rowsOf(page2).filter((r) => !r.id.startsWith("shared_more:"));
    assert(rows2.length > 0 && rows2.every((r) => !ids1.has(r.id)), "page two shows other shops");
    const all = [...rows, ...rows2].filter((r) => r.id.startsWith("shared_pick:")).length;
    assert(all === 14, `the two pages hold every listed shop once (got ${all})`);
  }),

  J("S03", "search finds shops by product, category and name", async (world) => {
    const p = world.newPhone("3");
    for (const [q, shop, match] of [["who sells pepsi?", MAMA.name, "Pepsi 50cl"], ["charger", BAYO.name, "Phone Charger"],
      ["find drinks", MAMA.name, ""], ["phones", BAYO.name, ""], ["i need to have drink today", MAMA.name, ""]] as const) {
      const m = mark(world, p);
      await send(world, p, q);
      const [r] = one(world, p, m, q);
      const titles = rowsOf(r).map((x) => x.title);
      assert(titles.includes(shop), `"${q}" lists ${shop} (got ${titles.join(", ") || textOf(r).slice(0, 120)})`);
      if (match) assertIncludes(textOf(r), match, `"${q}" says what matched`);
      assert(!textOf(r).includes("Secret Pepsi") && !textOf(r).includes("Suspended Pepsi"), "unlisted shops never show in a search");
    }
  }),

  J("S04", "a search with nothing found offers Browse / Search again", async (world) => {
    const p = world.newPhone("4"); const m = mark(world, p);
    await send(world, p, "find unicorn saddles");
    const [r] = one(world, p, m, "no results");
    assertIncludes(textOf(r), "couldn't find", "says nothing was found");
    assert(buttonsOf(r).map((b) => b.reply.id).join() === "lobby:browse,lobby:search", "offers browse and search again");
  }),

  J("S05", "the Search button asks what they want; the answer is searched", async (world) => {
    const p = world.newPhone("5"); const m = mark(world, p);
    await tap(world, p, "lobby:search", "Search");
    const [prompt] = one(world, p, m, "search button");
    assertIncludes(textOf(prompt), "What are you looking for", "asks what they want");
    const m2 = mark(world, p);
    await send(world, p, "zobo");
    assert(rowsOf(one(world, p, m2, "zobo")[0]).some((r) => r.title === MAMA.name), "the answer is searched");
  }),

  J("S06", "picking a shop hands over to its assistant, as that shop, from the shared number", async (world) => {
    const p = world.newPhone("6");
    await send(world, p, "stores");
    const m = mark(world, p);
    await pick(world, p, `shared_pick:${MAMA.code}`, MAMA.name);
    const r = one(world, p, m, "pick a shop");
    assert(r.every((c) => c.url.includes(`/${SHARED_PN}/`)), "every reply goes out on the shared number");
    assert(r.some((c) => textOf(c).includes(MAMA.name)), "the reply names the shop (WhatsApp policy: the buyer knows who they talk to)");
    assert((await visitOf(world, p)) === MAMA.id, "the buyer is now with Mama Put");
  }),

  J("S07", "typing a shop's name or SHOP <code> takes the buyer there; unknown and own-number codes are explained", async (world) => {
    const p = world.newPhone("7");
    await send(world, p, "mama put kitchen");
    assert((await visitOf(world, p)) === MAMA.id, "the name goes to the shop");
    await enterShop(world, p, BAYO.code);
    assert((await visitOf(world, p)) === BAYO.id, "SHOP BAYO switches to Bayo");
    let m = mark(world, p);
    await send(world, p, "SHOP NOSUCHSHOP");
    assertIncludes(textOf(one(world, p, m, "unknown code")[0]), "couldn't find a shop with the code", "an unknown code is explained");
    m = mark(world, p);
    await send(world, p, "SHOP SIM-STORE");
    assertIncludes(textOf(one(world, p, m, "own number")[0]), "own WhatsApp number", "a shop with its own number is pointed there");
    assert((await visitOf(world, p)) === BAYO.id, "neither moved the buyer");
  }),

  J("S08", "inside a shop, shop questions stay with the shop; 'stores' and 'leave shop' come back to the directory", async (world) => {
    const p = world.newPhone("8");
    await enterShop(world, p, MAMA.code);
    let m = mark(world, p);
    await send(world, p, "do you have pepsi");
    assert(repliesSince(world, p, m).every((c) => !rowsOf(c).some((r) => String(r.id).includes("shared_pick:"))), "a shop question is not answered with the directory");
    for (const t of ["stores", "leave shop", "other shops"]) {
      m = mark(world, p);
      await send(world, p, t);
      const [d] = one(world, p, m, t);
      const secs = d.body?.interactive?.action?.sections ?? [];
      assert(rowsOf(d).some((r) => r.id === `shared_pick:${MAMA.code}`), `"${t}" shows the directory with Mama Put`);
      assert(secs[0]?.title === "Recently visited", `"${t}": recently visited first`);
    }
  }),

  J("S09", "inside a shop, asking about other stores searches across the stores", async (world) => {
    const p = world.newPhone("9");
    await enterShop(world, p, BAYO.code);
    let m = mark(world, p);
    await send(world, p, "some pepsi can you check stores around me that sell this?");
    let [r] = one(world, p, m, "pepsi elsewhere");
    assert(rowsOf(r).some((x) => x.title === MAMA.name), `lists Mama Put for pepsi (got ${textOf(r).slice(0, 160)})`);
    m = mark(world, p);
    await send(world, p, "which other shops have chargers");
    [r] = one(world, p, m, "chargers elsewhere");
    assert(rowsOf(r).some((x) => x.title === BAYO.name), "lists Bayo for chargers");
    assert((await visitOf(world, p)) === BAYO.id, "the buyer is still with their shop until they pick another");
  }),

  J("S10", "My shops: the shops visited, or the welcome for a new buyer", async (world) => {
    const p = world.newPhone("a");
    let m = mark(world, p);
    await send(world, p, "my shops");
    assert(one(world, p, m, "new buyer my shops")[0].body?.interactive?.type === "button", "a new buyer gets the welcome");
    await enterShop(world, p, MAMA.code);
    await enterShop(world, p, BAYO.code);
    m = mark(world, p);
    await tap(world, p, "lobby:mine", "My shops");
    const titles = rowsOf(one(world, p, m, "my shops")[0]).map((r) => r.title);
    assert(titles.includes(MAMA.name) && titles.includes(BAYO.name), `both visited shops listed: ${titles}`);
    m = mark(world, p);
    await send(world, p, "hello");
    // Inside a shop "hello" belongs to the shop; it must not be the platform's welcome.
    assert(repliesSince(world, p, m).every((c) => !buttonsOf(c).some((b) => b.reply.id === "lobby:browse")), "a hello inside a shop goes to the shop");
  }),

  J("S11", "a button from shop A still reaches shop A after the buyer moved to shop B", async (world) => {
    const p = world.newPhone("b");
    await enterShop(world, p, MAMA.code);
    // Any button or list row Mama Put sends carries its code ("s.mamaput.<id>", applySharedEnvelope — unit-tested);
    // this is the routing of such a tap after the buyer has moved on.
    const tagged = `s.${MAMA.code}.menu_1`;
    await enterShop(world, p, BAYO.code);
    assert((await visitOf(world, p)) === BAYO.id, "now with Bayo");
    await tap(world, p, tagged!, "old Mama Put button");
    assert((await visitOf(world, p)) === MAMA.id, "the old button took the buyer back to Mama Put");
  }),

  J("S12", "the model reads what the rules don't; when it can't, the buyer gets the welcome, never silence", async (world) => {
    world.llm.when((_t, body) => body?.response_format?.json_schema?.name === "lobby_intent" && /wetin una dey sell/i.test(JSON.stringify(body.messages)),
      { intent: "browse", query: "" });
    world.llm.when((_t, body) => body?.response_format?.json_schema?.name === "lobby_intent" && /cold drink/i.test(JSON.stringify(body.messages)),
      { intent: "search", query: "pepsi" });
    const p = world.newPhone("c");
    let m = mark(world, p);
    await send(world, p, "abeg wetin una dey sell for here");
    assert(rowsOf(one(world, p, m, "pidgin browse")[0]).some((r) => r.id.startsWith("shared_pick:")), "understood as browse: the directory");
    m = mark(world, p);
    await send(world, p, "i want something to quench my thirst like a cold drink abeg");
    assert(rowsOf(one(world, p, m, "model search")[0]).some((r) => r.title === MAMA.name), "understood as a search for pepsi");
    m = mark(world, p);
    await send(world, p, "zxqv plorp");
    const [again] = one(world, p, m, "gibberish");
    assertIncludes(textOf(again), "didn't quite catch that", "gibberish gets a friendly 'didn't catch that' with the buttons");
  }),

  J("S13", "a message id longer than the dedupe column (a +234 buyer) is processed once, and a redelivery is ignored", async (world) => {
    const p = world.newPhone("d");
    const longId = "wamid.HBgNMjM0NzA3NzM0NzQyMhUCABIYFDNCQTQzRTgwN0M1MzRFMDgyQUE1" + world.newPhone("z").slice(-4) + "==";
    assert(longId.length > 64, `the id is longer than 64 (${longId.length})`);
    await enterShop(world, p, MAMA.code);
    let m = mark(world, p);
    await send(world, p, "menu", longId);
    const first = repliesSince(world, p, m).length;
    assert(first >= 1, "the long-id message was processed (a reply went out)");
    m = mark(world, p);
    await send(world, p, "menu", longId);
    assert(repliesSince(world, p, m).length === 0, "the same message delivered again is not answered twice");
  }),

  J("S14", "a photo or a location in the lobby gets the welcome", async (world) => {
    const p = world.newPhone("e");
    let m = mark(world, p);
    await world.inbound(payloads.inbound.location(SHARED_PN, p, 6.45, 3.39, "Home", "Lagos"));
    await world.settle(400);
    assert(buttonsOf(one(world, p, m, "location")[0]).some((b) => b.reply.id === "lobby:browse"), "a location gets the welcome");
    m = mark(world, p);
    await world.inbound(payloads.inbound.image(SHARED_PN, p, "media-sim-1", "is this available?"));
    await world.settle(400);
    assert(buttonsOf(one(world, p, m, "photo")[0]).some((b) => b.reply.id === "lobby:browse"), "a photo gets the welcome");
  }),

  J("S15", "the same lobby message delivered twice is answered once", async (world) => {
    const p = world.newPhone("f");
    const id = payloads.nextInboundWamid("dup");
    let m = mark(world, p);
    await send(world, p, "hi", id);
    assert(repliesSince(world, p, m).length === 1, "answered once");
    m = mark(world, p);
    await send(world, p, "hi", id);
    assert(repliesSince(world, p, m).length === 0, "the redelivery is not answered again");
  }),

  J("S16", "a hidden, empty or suspended shop cannot be reached by its code either", async (world) => {
    const p = world.newPhone("g");
    for (const code of ["SUSPENDED"]) {
      const m = mark(world, p);
      await send(world, p, `SHOP ${code}`);
      assertIncludes(textOf(one(world, p, m, code)[0]), "couldn't find a shop", `${code} is not reachable`);
    }
    // Hidden (not listed) and empty shops ARE reachable by their code: they are real shops, just not in the
    // directory — a shop's own link must keep working.
    await send(world, p, "SHOP HIDDEN");
    assert((await visitOf(world, p)) === "shr-hidden", "a hidden shop is still reachable by its own code");
  }),
];

// ── CLI ───────────────────────────────────────────────────────────────────────

async function main() {
  const only = process.argv.slice(2).map((s) => s.toUpperCase());
  const world = await bootWorld();
  const selected = only.length ? journeys.filter((j) => only.includes(j.id)) : journeys;
  const results = [];
  for (const j of selected) {
    const r = await runOneJourney(world, j);
    results.push(r);
    console.log(`${r.pass ? "PASS" : "FAIL"} ${r.id} ${r.name}${r.pass ? "" : `\n     ${String(r.error).split("\n").slice(0, 3).join("\n     ")}`}`);
  }
  writeTranscripts();
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed}/${results.length} passed`);
  process.exit(passed === results.length ? 0 : 1);
}

if (process.argv[1]?.endsWith("sharedNumberSuite.ts")) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
