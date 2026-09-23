import { describe, it, expect, beforeEach } from "vitest";
import {
  screenEntity,
  matchEntries,
  parseSanctionsList,
  __resetSanctionsCache,
  BUNDLED_MINIMAL_LIST,
  CACHE_TTL_MS,
} from "../sanctions";
import { makeFakeHttp } from "../fakeHttp";

const LIST_URL = "https://lists.example.com/sanctions.json";

const REMOTE_LIST = [
  { name: "Konga Evil Enterprises", id: "RC999", list: "OFAC-SDN" },
  { name: "John Bada Doe", list: "UN" },
];

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { SANCTIONS_LIST_URL: LIST_URL, ...extra } as NodeJS.ProcessEnv;
}

function httpOk(body: unknown = REMOTE_LIST) {
  return makeFakeHttp({ routes: { [LIST_URL]: { status: 200, body } } });
}

beforeEach(() => __resetSanctionsCache());

describe("parseSanctionsList", () => {
  it("parses JSON array of objects", () => {
    const out = parseSanctionsList(REMOTE_LIST, "REMOTE");
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ name: "Konga Evil Enterprises", id: "RC999", list: "OFAC-SDN" });
  });
  it("parses CSV with header", () => {
    const out = parseSanctionsList("name,id,list\nKonga Evil Enterprises,RC999,OFAC-SDN\nJane Smith,,UN\n");
    expect(out).toHaveLength(2);
    expect(out[0].list).toBe("OFAC-SDN");
    expect(out[1]).toEqual({ name: "Jane Smith", id: undefined, list: "UN" });
  });
  it("parses bare JSON string body", () => {
    const out = parseSanctionsList(JSON.stringify(REMOTE_LIST));
    expect(out).toHaveLength(2);
  });
  it("parses wrapped { entries: [...] } payload", () => {
    const out = parseSanctionsList({ entries: [{ name: "X Y" }] });
    expect(out).toEqual([{ name: "X Y", id: undefined, list: "REMOTE" }]);
  });
  it("keeps commas and escaped quotes inside quoted CSV fields", () => {
    const out = parseSanctionsList('name,id,list\n"Doe, John",RC1,UN\n"The ""Big"" Co",,EU\n');
    expect(out).toEqual([
      { name: "Doe, John", id: "RC1", list: "UN" },
      { name: 'The "Big" Co', id: undefined, list: "EU" },
    ]);
  });
  it("still reads a legacy headerless name,id,list CSV", () => {
    expect(parseSanctionsList("Konga Evil Enterprises,RC999,UN\n")).toEqual([
      { name: "Konga Evil Enterprises", id: "RC999", list: "UN" },
    ]);
  });
});

// Real rows from OFAC's published sdn.csv (headerless: ent_num, name, type, program, ...).
const OFAC_SDN_CSV = [
  '36,"AEROCARIBBEAN AIRLINES",-0- ,"CUBA",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ',
  '173,"ANGLO-CARIBBEAN CO., LTD.",-0- ,"CUBA",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ',
  `306,"BANCO NACIONAL DE CUBA",-0- ,"CUBA",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,"a.k.a. 'BNC'."`,
].join("\r\n");

describe("OFAC SDN csv layout", () => {
  it("reads the name from column 1, not the entity number in column 0", () => {
    const out = parseSanctionsList(OFAC_SDN_CSV, "OFAC-SDN");
    expect(out.map((e) => e.name)).toEqual([
      "AEROCARIBBEAN AIRLINES",
      "ANGLO-CARIBBEAN CO., LTD.",
      "BANCO NACIONAL DE CUBA",
    ]);
    expect(out.every((e) => e.list === "OFAC-SDN")).toBe(true);
  });
  it("does not expose the SDN entity number as a registration-number id", () => {
    const out = parseSanctionsList(OFAC_SDN_CSV, "OFAC-SDN");
    expect(out.every((e) => e.id === undefined)).toBe(true);
    // an unrelated business whose registration number is "36" must not hard-match
    expect(matchEntries({ name: "Totally Different Ltd", registrationNumber: "36" }, out)).toHaveLength(0);
  });
  it("catches a real sanctioned name (regression: entity numbers used to be read as names)", () => {
    const out = parseSanctionsList(OFAC_SDN_CSV, "OFAC-SDN");
    const m = matchEntries({ name: "Banco Nacional de Cuba" }, out);
    expect(m).toHaveLength(1);
    expect(m[0].list).toBe("OFAC-SDN");
    expect(matchEntries({ name: "Acme Trading Nigeria Ltd" }, out)).toHaveLength(0);
  });
  it("screenEntity end to end against an SDN-format remote list", async () => {
    const http = makeFakeHttp({ routes: { [LIST_URL]: { status: 200, body: OFAC_SDN_CSV } } });
    const hit = await screenEntity({ name: "BANCO NACIONAL DE CUBA" }, { env: env(), http });
    expect(hit.source).toBe("remote");
    expect(hit.hit).toBe(true);
    expect(hit.degraded).toBeUndefined();
    __resetSanctionsCache();
    const clean = await screenEntity({ name: "Acme Trading Nigeria Ltd" }, { env: env(), http });
    expect(clean.hit).toBe(false);
  });
});

describe("fuzzy matching", () => {
  it("exact name is a hit with score 1", () => {
    const m = matchEntries({ name: "Konga Evil Enterprises" }, REMOTE_LIST);
    expect(m[0].score).toBe(1);
  });
  it("case/diacritic/punctuation variants hit", () => {
    const m = matchEntries({ name: "konga  EVIL enterprises!!" }, REMOTE_LIST);
    expect(m).toHaveLength(1);
  });
  it("token overlap >= 0.8 hits (4/5 shared tokens)", () => {
    const m = matchEntries({ name: "Konga Evil Enterprises International Limited" }, [
      { name: "Konga Evil Enterprises Limited", list: "OFAC-SDN" },
    ]);
    expect(m).toHaveLength(1);
    expect(m[0].score).toBeGreaterThanOrEqual(0.8);
  });
  it("below threshold does not hit", () => {
    const m = matchEntries({ name: "Konga Pure Foods Limited" }, REMOTE_LIST);
    expect(m).toHaveLength(0);
  });
  it("registration number match is a hard hit", () => {
    const m = matchEntries({ name: "Totally Different Name", registrationNumber: "rc999" }, REMOTE_LIST);
    expect(m).toHaveLength(1);
    expect(m[0].score).toBe(1);
  });
});

describe("screenEntity sources", () => {
  it("remote hit", async () => {
    const res = await screenEntity({ name: "Konga Evil Enterprises" }, { env: env(), http: httpOk() });
    expect(res.hit).toBe(true);
    expect(res.source).toBe("remote");
    expect(res.matches[0].list).toBe("OFAC-SDN");
    expect(res.degraded).toBeUndefined();
  });

  it("remote clean pass", async () => {
    const res = await screenEntity({ name: "Innocent Trading Company" }, { env: env(), http: httpOk() });
    expect(res.hit).toBe(false);
    expect(res.matches).toEqual([]);
  });

  it("second call within 24h is served from cache (no refetch)", async () => {
    const http = httpOk();
    await screenEntity({ name: "Innocent Trading" }, { env: env(), http, now: 1_000_000 });
    const res = await screenEntity(
      { name: "Innocent Trading" },
      { env: env(), http, now: 1_000_000 + CACHE_TTL_MS - 1 },
    );
    expect(res.source).toBe("cache");
    expect(http.requests).toHaveLength(1);
  });

  it("cache expiry after 24h triggers refetch", async () => {
    const http = httpOk();
    await screenEntity({ name: "Innocent Trading" }, { env: env(), http, now: 1_000_000 });
    const res = await screenEntity(
      { name: "Innocent Trading" },
      { env: env(), http, now: 1_000_000 + CACHE_TTL_MS + 1 },
    );
    expect(res.source).toBe("remote");
    expect(http.requests).toHaveLength(2);
  });

  it("remote down + stale cache => staleCache flag, still screens", async () => {
    const good = httpOk();
    await screenEntity({ name: "Konga Evil Enterprises" }, { env: env(), http: good, now: 1_000_000 });
    const bad = makeFakeHttp({ routes: { [LIST_URL]: { error: new Error("down") } } });
    const res = await screenEntity(
      { name: "Konga Evil Enterprises" },
      { env: env(), http: bad, now: 1_000_000 + CACHE_TTL_MS + 1 },
    );
    expect(res.hit).toBe(true);
    expect(res.staleCache).toBe(true);
    expect(res.degraded).toBeUndefined();
  });

  it("dev fallback: bundled list used when no URL configured and no cache", async () => {
    const res = await screenEntity(
      { name: "Boko Haram" },
      // W30 merge: explicit test env — unset NODE_ENV is now treated as prod
      // (fail-closed), which is exactly what these dev-fallback tests exclude.
      { env: { NODE_ENV: "test" } as NodeJS.ProcessEnv, http: makeFakeHttp({ routes: {} }) },
    );
    expect(res.source).toBe("bundled");
    expect(res.hit).toBe(true);
  });

  it("dev fallback: bundled clean entity passes", async () => {
    const res = await screenEntity(
      { name: "Mama Ngozi Provisions" },
      { env: { NODE_ENV: "test" } as NodeJS.ProcessEnv, http: makeFakeHttp({ routes: {} }) },
    );
    expect(res.source).toBe("bundled");
    expect(res.hit).toBe(false);
  });
});

describe("degraded / fail-closed mode", () => {
  const prodEnv = env({ NODE_ENV: "production" });

  it("prod + remote down + no cache => degraded conservative hit", async () => {
    const bad = makeFakeHttp({ routes: { [LIST_URL]: { error: new Error("down") } } });
    const res = await screenEntity({ name: "Mama Ngozi Provisions" }, { env: prodEnv, http: bad });
    expect(res.degraded).toBe(true);
    expect(res.hit).toBe(true);
    expect(res.matches).toEqual([]);
  });

  it("prod: bundled list is NOT used as fallback", async () => {
    const bad = makeFakeHttp({ routes: { [LIST_URL]: { status: 500, body: {} } } });
    const res = await screenEntity({ name: "Boko Haram" }, { env: prodEnv, http: bad });
    expect(res.source).toBe("degraded");
  });

  it("dev + SANCTIONS_ALLOW_BUNDLED=false => degraded", async () => {
    const bad = makeFakeHttp({ routes: { [LIST_URL]: { error: new Error("down") } } });
    const res = await screenEntity(
      { name: "Mama Ngozi Provisions" },
      { env: env({ SANCTIONS_ALLOW_BUNDLED: "false" }), http: bad },
    );
    expect(res.degraded).toBe(true);
  });

  it("bundled minimal list has entries (dev fallback is non-empty)", () => {
    expect(BUNDLED_MINIMAL_LIST.length).toBeGreaterThan(0);
  });
});
