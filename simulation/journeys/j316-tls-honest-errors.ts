/**
 * === W42 secrets/auth (Coder B) ===
 * J316 — TLS policy: verification is ON by default, a CA-bundle env override
 * is honored, an unusable CA override is an HONEST error (never a silent
 * insecure connect), and the dev opt-out is explicit.
 */
import { assert, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J316",
  name: "TLS misconfig honest error",
  feature: "PLT-14 rejectUnauthorized=true + CA bundle env override",
  async run(_world: World) {
    const { buildTlsOptions } = await import("../../server/_core/tlsConfig");
    const saved = {
      ca: process.env.PG_TLS_CA,
      insecure: process.env.PG_TLS_REJECT_UNAUTHORIZED,
    };
    delete process.env.PG_TLS_CA;
    delete process.env.PG_TLS_REJECT_UNAUTHORIZED;
    try {
      // Default: full verification, no custom CA.
      const dflt = buildTlsOptions("Postgres", "PG");
      assert(dflt.rejectUnauthorized === true, "rejectUnauthorized defaults to true");
      assert(dflt.ca === undefined, "no CA by default");

      // Inline CA bundle override — verification stays on, bundle trusted.
      const pem = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";
      process.env.PG_TLS_CA = pem;
      const withCa = buildTlsOptions("Postgres", "PG");
      assert(withCa.rejectUnauthorized === true && withCa.ca === pem, "inline CA bundle honored");

      // Misconfig: path that does not exist → honest throw, not silent insecure.
      process.env.PG_TLS_CA = "/nonexistent/j316-ca.crt";
      let honestErr = false;
      try {
        buildTlsOptions("Postgres", "PG");
      } catch (e: any) {
        honestErr = /PG_TLS_CA/.test(e?.message ?? "") && /refusing to connect/.test(e?.message ?? "");
      }
      assert(honestErr, "unreadable CA path is an honest error naming the env var");

      // Misconfig: garbage that is neither PEM nor file → honest throw.
      process.env.PG_TLS_CA = "not-a-pem-not-a-path";
      let garbageErr = false;
      try {
        buildTlsOptions("Postgres", "PG");
      } catch (e: any) {
        garbageErr = /refusing to connect/.test(e?.message ?? "");
      }
      assert(garbageErr, "garbage CA override is an honest error");

      // Explicit dev opt-out — allowed but visible.
      delete process.env.PG_TLS_CA;
      process.env.PG_TLS_REJECT_UNAUTHORIZED = "false";
      const insecure = buildTlsOptions("Postgres", "PG");
      assert(insecure.rejectUnauthorized === false, "explicit opt-out honored");
    } finally {
      if (saved.ca === undefined) delete process.env.PG_TLS_CA; else process.env.PG_TLS_CA = saved.ca;
      if (saved.insecure === undefined) delete process.env.PG_TLS_REJECT_UNAUTHORIZED; else process.env.PG_TLS_REJECT_UNAUTHORIZED = saved.insecure;
    }
  },
};
