import { QueryClient } from "@tanstack/react-query";
import { queryHasEmptyTenantId } from "./tenantAccess";

/**
 * The QueryClient all three apps (legacy client, ui/tenant-portal, ui/platform-admin) share. Its opinions:
 *   - a query for "the business with no id" never goes to the network (a page that passes its own `enabled`
 *     still decides for itself — this only ever narrows, never widens, when a queryKey needs it).
 *   - === W48 perf (PERF-FE-3): data is treated as fresh for 30s and queries no longer all refire on every
 *     window focus — was causing a refetch storm across every mounted query on every tab switch.
 */
export function createAppQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        enabled: (query) => !queryHasEmptyTenantId(query.queryKey),
        staleTime: 30_000,
        refetchOnWindowFocus: false,
      },
    },
  });
}
