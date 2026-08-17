/**
 * Test-only generic in-memory drizzle fake for the W19 SOC2 services/routers.
 * Same decode idea as services/creditFacilities/fakeDb.ts, but generic:
 * column names are resolved via drizzle's getTableColumns, and eq/lt/gt/
 * isNull predicates combined with and/or are evaluated from queryChunks.
 */
import { getTableColumns } from "drizzle-orm";

interface Predicate {
  prop: string;
  op: "eq" | "lt" | "gt" | "lte" | "gte" | "isNull";
  value?: unknown;
  orWithPrev?: boolean;
}


function decodePredicates(cond: unknown, nameToProp: Map<string, string>): Predicate[] {
  const preds: Predicate[] = [];
  let pendingCol: string | null = null;
  let pendingOp: Predicate["op"] = "eq";
  let orNext = false;
  const scan = (cs: unknown[]): void => {
    for (const c of cs) {
      if (c == null) continue;
      if (Array.isArray(c)) { scan(c); continue; }
      if (typeof c !== "object") continue;
      const o = c as Record<string, any>;
      const ctor = o.constructor?.name;
      if (ctor === "Column" || (typeof o.name === "string" && o.table != null)) {
        pendingCol = nameToProp.get(o.name) ?? o.name;
        pendingOp = "eq";
        continue;
      }
      if (ctor === "StringChunk") {
        const s = String(o.value ?? "");
        if (/\bor\b/i.test(s)) orNext = true;
        if (/is null/i.test(s) && pendingCol) {
          preds.push({ prop: pendingCol, op: "isNull", orWithPrev: orNext }); orNext = false; pendingCol = null;
        } else if (s.includes("<=")) pendingOp = "lte";
        else if (s.includes(">=")) pendingOp = "gte";
        else if (s.includes("<")) pendingOp = "lt";
        else if (s.includes(">")) pendingOp = "gt";
        continue;
      }
      if (ctor === "Param" || "value" in o) {
        if (pendingCol) {
          preds.push({ prop: pendingCol, op: pendingOp, value: o.value, orWithPrev: orNext });
          orNext = false; pendingCol = null; pendingOp = "eq";
        }
        continue;
      }
      if (Array.isArray(o.queryChunks)) scan(o.queryChunks);
    }
  };
  scan([(cond as any)]);
  return preds;
}

function matchPreds(row: any, preds: Predicate[]): boolean {
  let result: boolean | null = null;
  for (const p of preds) {
    const rv = row[p.prop];
    let ok: boolean;
    switch (p.op) {
      case "isNull": ok = rv == null; break;
      case "eq": ok = rv === p.value || (rv instanceof Date && p.value instanceof Date && rv.getTime() === (p.value as Date).getTime()); break;
      case "lt": ok = rv < (p.value as any); break;
      case "gt": ok = rv > (p.value as any); break;
      case "lte": ok = rv <= (p.value as any); break;
      case "gte": ok = rv >= (p.value as any); break;
    }
    result = result === null ? ok : p.orWithPrev ? result || ok : result && ok;
  }
  return result ?? true;
}

function decodeOrders(orders: unknown[], nameToProp: Map<string, string>): Array<{ prop: string; dir: "asc" | "desc" }> {
  const out: Array<{ prop: string; dir: "asc" | "desc" }> = [];
  for (const ord of orders) {
    let prop: string | null = null;
    let dir: "asc" | "desc" = "asc";
    const scan = (cs: unknown[]): void => {
      for (const c of cs) {
        if (c == null) continue;
        if (Array.isArray(c)) { scan(c); continue; }
        if (typeof c !== "object") continue;
        const o = c as Record<string, any>;
        const ctor = o.constructor?.name;
        if (ctor === "Column" || (typeof o.name === "string" && o.table != null)) prop = nameToProp.get(o.name) ?? o.name;
        else if (ctor === "StringChunk" && /desc/i.test(String(o.value))) dir = "desc";
        else if (Array.isArray(o.queryChunks)) scan(o.queryChunks);
      }
    };
    scan([ord]);
    if (prop) out.push({ prop, dir });
  }
  return out;
}

function applyOrders(rows: any[], orders: Array<{ prop: string; dir: "asc" | "desc" }>): any[] {
  const sorted = [...rows];
  sorted.sort((a, b) => {
    for (const o of orders) {
      const av = a[o.prop] instanceof Date ? a[o.prop].getTime() : a[o.prop];
      const bv = b[o.prop] instanceof Date ? b[o.prop].getTime() : b[o.prop];
      if (av < bv) return o.dir === "asc" ? -1 : 1;
      if (av > bv) return o.dir === "asc" ? 1 : -1;
    }
    return 0;
  });
  return sorted;
}

/**
 * store: Map<table-object, rows-array>. Rows use the schema's camelCase
 * property names.
 */
export function makeSoc2FakeDb(store: Map<any, any[]>) {
  const colMaps = new Map<any, Map<string, string>>();
  const mapFor = (table: any): Map<string, string> => {
    let m = colMaps.get(table);
    if (!m) {
      m = new Map<string, string>();
      try {
        for (const [prop, col] of Object.entries(getTableColumns(table))) {
          m.set((col as any).name, prop);
        }
      } catch { /* non-pgTable (e.g. subquery) — leave empty */ }
      colMaps.set(table, m);
    }
    return m;
  };
  const rowsOf = (table: any): any[] => {
    const rows = store.get(table);
    if (!rows) throw new Error("soc2FakeDb: table not seeded");
    return rows;
  };

  function makeSelectChain(table: any, cond: any, fields?: Record<string, any>) {
    const chain: any = {
      where(c: any) { cond = c; return chain; },
      orderBy(...ords: any[]) { chain._orders = ords; return chain; },
      limit(n: number) { chain._limit = n; return Promise.resolve(run()); },
      then(resolve: any, reject: any) { return Promise.resolve(run()).then(resolve, reject); },
      _orders: undefined as any,
      _limit: undefined as number | undefined,
    };
    function run() {
      const m = mapFor(table);
      let rows = rowsOf(table);
      if (cond != null) {
        const preds = decodePredicates(cond, m);
        rows = rows.filter((r) => matchPreds(r, preds));
      }
      if (chain._orders) rows = applyOrders(rows, decodeOrders(chain._orders, m));
      rows = rows.map((r) => {
        if (!fields) return { ...r };
        // fields like { id: table.id } — project by column prop name
        return Object.fromEntries(Object.entries(fields).map(([k, col]: [string, any]) => {
          const prop = m.get(col?.name) ?? k;
          return [k, r[prop]];
        }));
      });
      if (chain._limit != null) rows = rows.slice(0, chain._limit);
      return rows;
    }
    return chain;
  }

  const db: any = {
    store,
    select(fields?: Record<string, any>) {
      return {
        from(table: any) { return makeSelectChain(table, null, fields); },
      };
    },
    insert(table: any) {
      return {
        values(v: any) {
          const row = { ...v };
          if (row.id == null) row.id = crypto.randomUUID();
          rowsOf(table).push(row);
          return {
            returning() { return Promise.resolve([{ ...row }]); },
            then(resolve: any, reject: any) { return Promise.resolve([{ ...row }]).then(resolve, reject); },
          };
        },
      };
    },
    update(table: any) {
      return {
        set(vals: any) {
          return {
            where(cond: any) {
              const m = mapFor(table);
              const preds = decodePredicates(cond, m);
              const matched: any[] = [];
              for (const r of rowsOf(table)) {
                if (matchPreds(r, preds)) {
                  Object.assign(r, vals);
                  matched.push({ ...r });
                }
              }
              return {
                returning() { return Promise.resolve(matched); },
                then(resolve: any, reject: any) { return Promise.resolve(matched).then(resolve, reject); },
              };
            },
          };
        },
      };
    },
    delete(table: any) {
      return {
        where(cond: any) {
          const m = mapFor(table);
          const preds = decodePredicates(cond, m);
          const rows = rowsOf(table);
          for (let i = rows.length - 1; i >= 0; i--) {
            if (matchPreds(rows[i], preds)) rows.splice(i, 1);
          }
          return Promise.resolve();
        },
      };
    },
  };
  return db;
}
