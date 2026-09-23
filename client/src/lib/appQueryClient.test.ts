import { describe, it, expect, vi } from "vitest";
import { QueryObserver } from "@tanstack/query-core";
import { createTRPCReact, getQueryKey } from "@trpc/react-query";
import { createAppQueryClient } from "./appQueryClient";
import { queryHasEmptyTenantId } from "./tenantAccess";

// The real tRPC key builder, so a change in the key shape breaks THIS test instead of silently disabling the guard.
const trpc: any = createTRPCReact<any>();
const keyFor = (input: unknown) => getQueryKey(trpc.product.stats, input as any, "query");

async function fires(queryKey: readonly unknown[], extra: Record<string, unknown> = {}): Promise<boolean> {
  const qc = createAppQueryClient();
  const queryFn = vi.fn().mockResolvedValue("ok");
  const observer = new QueryObserver(qc, { queryKey, queryFn, retry: false, ...extra });
  const unsubscribe = observer.subscribe(() => {});
  await new Promise((r) => setTimeout(r, 20));
  unsubscribe();
  qc.clear();
  return queryFn.mock.calls.length > 0;
}

describe("queryHasEmptyTenantId", () => {
  it("recognises the real tRPC key for an empty tenant", () => {
    expect(queryHasEmptyTenantId(keyFor({ tenantId: "" }))).toBe(true);
    expect(queryHasEmptyTenantId(keyFor({ tenantId: "   " }))).toBe(true);
  });
  it("ignores real tenants, other inputs and keys without a tenant", () => {
    expect(queryHasEmptyTenantId(keyFor({ tenantId: "00b649e9" }))).toBe(false);
    expect(queryHasEmptyTenantId(keyFor({ limit: 5 }))).toBe(false);
    expect(queryHasEmptyTenantId(keyFor(undefined))).toBe(false);
    expect(queryHasEmptyTenantId(["not-trpc"])).toBe(false);
  });
});

describe("createAppQueryClient — tenant queries with no business yet", () => {
  it("does not send a query whose tenantId is empty (the 403s a new user saw on every page)", async () => {
    expect(await fires(keyFor({ tenantId: "" }))).toBe(false);
  });
  it("still sends the same query once there is a tenant", async () => {
    expect(await fires(keyFor({ tenantId: "00b649e9" }))).toBe(true);
  });
  it("still sends queries that carry no tenant at all (auth.me, public pages)", async () => {
    expect(await fires(getQueryKey(trpc.auth.me, undefined, "query"))).toBe(true);
  });
  it("a page that sets its own enabled keeps control", async () => {
    expect(await fires(keyFor({ tenantId: "" }), { enabled: true })).toBe(true);
  });
});
