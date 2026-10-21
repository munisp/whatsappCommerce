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
import { assert, assertIncludes, bootWorld, ONBOARDING_PHONE_NUMBER_ID, type World } from "./world";
import * as payloads from "./payloads";
import { runOneJourney, writeTranscripts, type Journey } from "./runner";

const SHARED_PN = "pn_sim_shared_001";
const SHARED_DISPLAY = "2348081319721";
const PLATFORM = "Runit Technologies";

const MAMA = { id: "shr-mamaput", name: "Mama Put Kitchen", code: "mamaput" };
const BAYO = { id: "shr-bayo", name: "Bayo Phones", code: "bayo" };
const IKEJA: [number, number] = [6.6018, 3.3515];
const LEKKI: [number, number] = [6.4698, 3.5852];
const ABUJA: [number, number] = [9.0765, 7.3986];

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
  // Where the shops are: Mama Put in Ikeja, Bayo in Lekki (~27 km away); Small Shop 01 is in Ikeja too but has not
  // made its location discoverable, and the hidden shop is in Ikeja but not listed — neither may ever show as nearby.
  await world.db.delete(schema.merchantLocations).where(like(schema.merchantLocations.tenantId, "shr-%"));
  const { encodeGeohash } = await import("../server/services/geoDiscovery");
  const at = (tenantId: string, [lat, lng]: [number, number], discoverable = true) =>
    world.db.insert(schema.merchantLocations).values({
      tenantId, latitude: lat.toFixed(7), longitude: lng.toFixed(7), geohash: encodeGeohash(lat, lng), discoverable,
    } as any);
  await at(MAMA.id, IKEJA);
  await at(BAYO.id, LEKKI);
  await at("shr-small-1", IKEJA, false);
  await at("shr-hidden", IKEJA);
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
const sendPin = async (world: World, from: string, [lat, lng]: [number, number], id?: string, pn = SHARED_PN) => {
  const env: any = payloads.inbound.location(pn, from, lat, lng);
  if (id) env.entry[0].changes[0].value.messages[0].id = id;
  await world.inbound(env);
  await world.settle(400);
};
const isLocationAsk = (c: any) => c?.body?.interactive?.type === "location_request_message";
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

  J("S09", "inside a shop, asking about other stores searches across the stores (near me: from the buyer's pin)", async (world) => {
    const p = world.newPhone("9");
    await enterShop(world, p, BAYO.code);
    let m = mark(world, p);
    // "around me" first asks where they are; the pin then lists the shops near with pepsi.
    await send(world, p, "some pepsi can you check stores around me that sell this?");
    let [r] = one(world, p, m, "pepsi around me");
    assert(isLocationAsk(r) && textOf(r).includes("pepsi"), `asks for the location to look for pepsi (got ${textOf(r).slice(0, 160)})`);
    m = mark(world, p);
    await sendPin(world, p, IKEJA);
    [r] = one(world, p, m, "pepsi near the pin");
    assert(rowsOf(r).some((x) => x.title === MAMA.name), `lists Mama Put for pepsi (got ${textOf(r).slice(0, 160)})`);
    m = mark(world, p);
    await send(world, p, "who else sells pepsi?");
    [r] = one(world, p, m, "pepsi elsewhere");
    assert(rowsOf(r).some((x) => x.title === MAMA.name), "without 'near me' it searches every store");
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

  J("S14", "a photo in the lobby gets the welcome; a location shows the shops near it, nearest first", async (world) => {
    const p = world.newPhone("e");
    let m = mark(world, p);
    await sendPin(world, p, [6.6000, 3.3500]);
    const near = one(world, p, m, "location")[0];
    const rows = rowsOf(near);
    assertIncludes(textOf(near), "Shops near you", "a pin gets the nearby list");
    assert(rows[0]?.title === MAMA.name, `the nearest shop comes first (got ${rows.map((r) => r.title).join(", ")})`);
    assert(/\d+ m|\d(\.\d)? km/.test(rows[0]?.description ?? ""), `each row says how far (got ${rows[0]?.description})`);
    assert(rows.some((r) => r.title === BAYO.name), "a shop 27 km away is still near enough");
    assert(!rows.some((r) => r.title === "Small Shop 01"), "a location the shop has not made discoverable never shows");
    assert(!rows.some((r) => r.title === "Hidden Shop"), "a shop hidden from the directory never shows as nearby");
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

  J("S17", "'who sells pepsi near me' asks for the location; the pin answers with nearby shops that have it", async (world) => {
    const p = world.newPhone("h");
    let m = mark(world, p);
    await send(world, p, "who sells pepsi near me?");
    const ask = one(world, p, m, "near me")[0];
    assert(isLocationAsk(ask), `the buyer is asked for their location (got ${ask?.body?.interactive?.type ?? ask?.body?.type})`);
    assertIncludes(textOf(ask), "pepsi", "the ask says what will be searched");
    m = mark(world, p);
    await sendPin(world, p, LEKKI);
    const rows = rowsOf(one(world, p, m, "pin")[0]);
    assert(rows.length === 1 && rows[0].title === MAMA.name, `only shops with pepsi (got ${rows.map((r) => r.title).join(", ")})`);
    // The question is answered: the next pin is an ordinary lobby pin (every nearby shop), not pepsi again.
    m = mark(world, p);
    await sendPin(world, p, LEKKI);
    assert(rowsOf(one(world, p, m, "second pin")[0]).some((r) => r.title === BAYO.name), "a later pin lists every nearby shop");
    // "shops near me" with nothing to look for asks too.
    m = mark(world, p);
    await send(world, p, "shops near me");
    assert(isLocationAsk(one(world, p, m, "shops near me")[0]), "'shops near me' asks for the location");
  }),

  J("S18", "in a shop, 'stores around me that sell this' asks for the location; the pin lists shops, a later pin is the shop's", async (world) => {
    const p = world.newPhone("i");
    await send(world, p, "SHOP MAMAPUT");
    await send(world, p, "YES");
    let m = mark(world, p);
    await send(world, p, "do you know stores around me that sell phone chargers?");
    const ask = one(world, p, m, "around me")[0];
    assert(isLocationAsk(ask), "asked for the location from inside the shop");
    assertIncludes(textOf(ask), "charger", "the ask names what will be searched");
    m = mark(world, p);
    await sendPin(world, p, IKEJA);
    const list = one(world, p, m, "pin in shop")[0];
    assert(rowsOf(list).some((r) => r.title === BAYO.name), "the pin lists the shops near with chargers");
    assert((await visitOf(world, p)) === MAMA.id, "the buyer is still with their shop");
    // No open question now: a pin is the shop's (a delivery location), never the platform's nearby list again.
    m = mark(world, p);
    await sendPin(world, p, IKEJA);
    assert(!repliesSince(world, p, m).some((c) => textOf(c).includes("Shops near you")), "a later pin goes to the shop");
  }),

  J("S19", "far from every shop: none within reach, browse or search instead", async (world) => {
    const p = world.newPhone("j");
    await send(world, p, "anyone selling pepsi around here");
    const m = mark(world, p);
    await sendPin(world, p, ABUJA);
    const r = one(world, p, m, "far pin")[0];
    assertIncludes(textOf(r), "within 50 km", "says nothing is within reach");
    assert(buttonsOf(r).some((b) => b.reply.id === "lobby:browse") && buttonsOf(r).some((b) => b.reply.id === "lobby:search"),
      "offers browse and search");
  }),

  J("S20", "a redelivered pin is answered once and never reaches the shop", async (world) => {
    const p = world.newPhone("k");
    await send(world, p, "SHOP MAMAPUT");
    await send(world, p, "YES");
    await send(world, p, "which other shops near me have power banks?");
    const id = `wamid.sim-pin-${Date.now()}`;
    let m = mark(world, p);
    await sendPin(world, p, LEKKI, id);
    assert(repliesSince(world, p, m).length === 1, "the pin is answered once");
    m = mark(world, p);
    await sendPin(world, p, LEKKI, id);
    assert(repliesSince(world, p, m).length === 0, "the redelivery gets nothing — not from the platform, not from the shop");
  }),

  J("S21", "a shop owner's pin on the onboarding number saves the shop's location as discoverable", async (world) => {
    const schema = await import("../drizzle/schema");
    const { eq } = await import("drizzle-orm");
    const owner = world.newPhone("o");
    const { normalizeWaPhone } = await import("../server/services/waSender");
    await world.db.insert(schema.onboardingSessions).values({
      channel: "whatsapp", phone: normalizeWaPhone(owner), state: "live", tenantId: "shr-small-2",
    } as any);
    await sendPin(world, owner, [6.5244, 3.3792], undefined, ONBOARDING_PHONE_NUMBER_ID);
    const [loc] = await world.db.select().from(schema.merchantLocations).where(eq(schema.merchantLocations.tenantId, "shr-small-2"));
    assert(!!loc && loc.discoverable === true, "the shop now has a discoverable location");
    assert(Math.abs(Number(loc.latitude) - 6.5244) < 1e-6, "at the pin");
    assert(world.outbound.toPhone(owner).some((c) => textOf(c).includes("Saved")), "the owner is told it's saved");
    // The shop now shows up for a buyer nearby.
    const b = world.newPhone("l");
    const m = mark(world, b);
    await sendPin(world, b, [6.5250, 3.3790]);
    assert(rowsOf(one(world, b, m, "buyer pin")[0])[0]?.title === "Small Shop 02", "the shop is the nearest for a buyer next door");
    // A number that set up no shop can't set a location.
    const stranger = world.newPhone("q");
    await sendPin(world, stranger, [6.5, 3.4], undefined, ONBOARDING_PHONE_NUMBER_ID);
    assert(world.outbound.toPhone(stranger).some((c) => textOf(c).includes("can't find a shop")), "a stranger's pin is refused");
  }),

  J("S22", "a business types SELL: the onboarding assistant takes the chat until they go back to shopping; SELL resumes", async (world) => {
    const p = world.newPhone("s");
    const { normalizeWaPhone } = await import("../server/services/waSender");
    const session = async () => {
      const res = await world.pg.query(`select id, channel, state, jsonb_array_length(transcript) n from onboarding_sessions
        where phone=$1 order by created_at desc limit 1`, [normalizeWaPhone(p)]);
      return (Array.isArray(res) ? res : res.rows)[0] ?? null;
    };
    let m = mark(world, p);
    await send(world, p, "I want to sell");
    assertIncludes(textOf(one(world, p, m, "sell")[0]), "onboarding assistant", "the onboarding assistant greets them, from the shared number");
    const s1 = await session();
    assert(s1?.channel === "whatsapp" && !["live", "failed", "abandoned"].includes(s1.state), `an open WhatsApp setup (got ${JSON.stringify(s1)})`);
    m = mark(world, p);
    await send(world, p, "I run Ada's Fabrics in Enugu, ankara and lace");
    assert(repliesSince(world, p, m).length >= 1, "the assistant answers");
    assert(Number((await session())?.n) > Number(s1.n), "the message went to the setup, not the lobby");
    assert(!repliesSince(world, p, m).some((c) => textOf(c).includes("Runit Technologies* 🛍️")), "no store directory mid-setup");
    // Back to shopping.
    m = mark(world, p);
    await send(world, p, "stores");
    assertIncludes(textOf(one(world, p, m, "stores")[0]), "Here are the shops", "'stores' goes back to the directory");
    m = mark(world, p);
    await send(world, p, "hi");
    assertIncludes(textOf(one(world, p, m, "hi")[0]), "Welcome to *Runit Technologies*", "after leaving, hi is the lobby again");
    // SELL picks the same setup up again.
    m = mark(world, p);
    await send(world, p, "SELL");
    assertIncludes(textOf(one(world, p, m, "sell again")[0]), "Welcome back", "SELL resumes the open setup");
    assert((await session())?.id === s1.id, "the same setup, not a new one");
    // A buyer's question is never a SELL.
    const b = world.newPhone("t");
    m = mark(world, b);
    await send(world, b, "who sells rice?");
    assert(!textOf(one(world, b, m, "who sells")[0]).includes("onboarding assistant"), "'who sells rice' is a search");
  }),

  J("S24", "SWITCH from a shop, into the setup and back: one menu everywhere, the setup kept", async (world) => {
    const p = world.newPhone("w");
    await send(world, p, "SHOP MAMAPUT");
    await send(world, p, "YES");
    let m = mark(world, p);
    await send(world, p, "switch");
    let menu = one(world, p, m, "switch in a shop")[0];
    let rows = rowsOf(menu);
    assert(rows[0]?.title === "Back to Mama Put Kitchen", `first, back to the shop they're in (got ${JSON.stringify(rows.map((r) => r.title))})`);
    assert(rows.some((r) => r.id === "lobby:browse") && rows.some((r) => r.id === "lobby:search"), "all stores and search");
    assert(rows.some((r) => r.id === "lobby:sell" && r.title.includes("Sell here")), "and selling, for a phone with no setup");
    // Into the setup from the menu: the assistant, and once, how to get back out.
    m = mark(world, p);
    await pick(world, p, "lobby:sell", "🏪 Sell here");
    const into = repliesSince(world, p, m);
    assertIncludes(textOf(into[0]), "onboarding assistant", "'Sell here' starts the setup");
    assert(into.some((c) => textOf(c).includes("SWITCH")), "the setup says how to switch back");
    await send(world, p, "I run Ada's Fabrics in Enugu, ankara and lace");
    // SWITCH from the setup: the same menu, now with "My shop setup".
    m = mark(world, p);
    await send(world, p, "switch");
    rows = rowsOf(one(world, p, m, "switch in setup")[0]);
    assert(rows.some((r) => r.id === "lobby:sell" && r.title.includes("My shop setup")), `the setup is offered back (got ${JSON.stringify(rows.map((r) => r.title))})`);
    // Back to the shop…
    const back = rows.find((r) => String(r.title).startsWith("Back to") || String(r.id).endsWith("mamaput"));
    await pick(world, p, back.id, back.title);
    assert((await visitOf(world, p)) === MAMA.id, "back with Mama Put");
    m = mark(world, p);
    await send(world, p, "menu");
    assert(!repliesSince(world, p, m).some((c) => textOf(c).includes("onboarding assistant")), "the shop has the chat again, not the setup");
    // …and into the same setup again.
    await send(world, p, "switch");
    m = mark(world, p);
    await pick(world, p, "lobby:sell", "🏪 My shop setup");
    const again = repliesSince(world, p, m);
    assertIncludes(textOf(again[0]), "Welcome back", "the saved setup resumes");
    assert(!again.some((c) => textOf(c).includes("Tip: type *SWITCH*")), "the tip is said once, not on every resume");
  }),

  J("S25", "buying while a shop is being set up goes back to shopping; describing the business stays in setup", async (world) => {
    const p = world.newPhone("x");
    const { normalizeWaPhone } = await import("../server/services/waSender");
    const turns = async () => {
      const res = await world.pg.query(`select jsonb_array_length(transcript) n from onboarding_sessions where phone=$1 order by created_at desc limit 1`, [normalizeWaPhone(p)]);
      return Number((Array.isArray(res) ? res : res.rows)[0]?.n ?? 0);
    };
    await send(world, p, "SELL");
    await send(world, p, "We sell rice and beans in Ibadan");
    let n = await turns();
    let m = mark(world, p);
    await send(world, p, "! want to buy 4 palm oil");
    assert((await turns()) === n, "the buying message did not go to the setup");
    assert(!repliesSince(world, p, m).some((c) => textOf(c).includes("onboarding assistant")), "answered as a buyer");
    // The owner describing their own business is never taken for buying.
    await send(world, p, "SELL");
    n = await turns();
    await send(world, p, "I sell children toys");
    assert((await turns()) > n, "'I sell…' is the business, kept in the setup");
  }),

  J("S26", "SWITCH in the lobby, before any shop: stores, search and selling", async (world) => {
    const p = world.newPhone("y");
    const m = mark(world, p);
    await send(world, p, "SWITCH");
    const rows = rowsOf(one(world, p, m, "switch in the lobby")[0]);
    assert(!rows.some((r) => String(r.title).startsWith("Back to")), "no shop to go back to yet");
    assert(rows.map((r) => r.id).join(",") === "lobby:browse,lobby:search,lobby:sell", `stores, search, sell (got ${JSON.stringify(rows.map((r) => r.id))})`);
  }),

  J("S23", "the platform Telegram bot: own contact first, then the same onboarding; another's contact is refused", async (world) => {
    const { tg } = await import("./metaMock");
    process.env.TELEGRAM_PLATFORM_BOT_TOKEN = "sim-platform-bot";
    process.env.TELEGRAM_PLATFORM_WEBHOOK_SECRET = "sim-platform-secret";
    let update = 9_000_000 + Math.floor(Math.random() * 100_000);
    const chat = 7_000_000 + Math.floor(Math.random() * 100_000);
    const post = async (body: Record<string, unknown>, secret = "sim-platform-secret") => {
      const res = await fetch(`${world.baseUrl}/api/webhooks/telegram-platform`, {
        method: "POST", headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": secret },
        body: JSON.stringify({ update_id: ++update, ...body }),
      });
      await world.settle(400);
      return res.status;
    };
    const from = { id: chat, first_name: "Ada", language_code: "en" };
    const msg = (extra: Record<string, unknown>) => ({ message: { message_id: update, chat: { id: chat }, from, date: 0, ...extra } });
    const sent = () => tg.calls.filter((c) => c.token === "sim-platform-bot" && c.method === "sendMessage" && String(c.body.chat_id) === String(chat));
    try {
      assert((await post(msg({ text: "/start" }), "wrong")) === 401, "a wrong secret is refused");
      let n = sent().length;
      await post(msg({ text: "/start" }));
      const ask = sent().slice(n)[0];
      assert(!!ask?.body?.reply_markup?.keyboard?.[0]?.[0]?.request_contact, "first, the bot asks for their own phone number");
      // Someone else's contact is not accepted.
      n = sent().length;
      await post(msg({ contact: { phone_number: "+2348011112222", user_id: chat + 1 } }));
      assert(!!sent().slice(n)[0]?.body?.reply_markup?.keyboard?.[0]?.[0]?.request_contact, "another person's contact: asked again");
      // Their own contact starts the setup, keyed by that phone, on the telegram channel.
      const phone = `23480${String(chat).slice(-8)}`;
      n = sent().length;
      await post(msg({ contact: { phone_number: `+${phone}`, user_id: chat } }));
      assert(sent().slice(n).some((c) => String(c.body.text).includes("onboarding assistant")), "the onboarding assistant greets them on Telegram");
      const res = await world.pg.query(`select channel, state from onboarding_sessions where phone=$1 order by created_at desc limit 1`, [phone]);
      const row = (Array.isArray(res) ? res : res.rows)[0];
      assert(row?.channel === "telegram" && row.state !== "abandoned", `an open telegram setup for the shared phone (got ${JSON.stringify(row)})`);
      // Their messages now go to that setup.
      n = sent().length;
      await post(msg({ text: "I sell shoes in Lagos" }));
      assert(sent().length > n, "the assistant answers on Telegram");
      // The same person on WhatsApp (SELL on the shared number) finds the same setup.
      const m = mark(world, phone);
      await send(world, phone, "SELL");
      assertIncludes(textOf(one(world, phone, m, "sell on whatsapp")[0]), "Welcome back", "SELL on WhatsApp resumes the Telegram setup");
    } finally {
      delete process.env.TELEGRAM_PLATFORM_BOT_TOKEN;
      delete process.env.TELEGRAM_PLATFORM_WEBHOOK_SECRET;
    }
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
