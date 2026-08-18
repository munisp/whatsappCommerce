import { trpc } from "@/lib/trpc";
import { COOKIE_NAME, UNAUTHED_ERR_MSG } from "@shared/const";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink, TRPCClientError } from "@trpc/client";
import { createRoot } from "react-dom/client";
import superjson from "superjson";
import App from "./App";
import { isLoggingOut, startLogin } from "@/const";
import "@/index.css";
import { TenantProvider } from "@/contexts/TenantContext";

// Vite fires this when a lazy route chunk fails to load — always true for any
// tab left open across a deploy, since each deploy replaces /assets/ with a
// fresh set of content-hashed files and the old chunk URL 404s (falls through
// to the SPA shell, which the module loader correctly refuses to execute).
// Reload once to pick up the current chunk manifest; the sessionStorage guard
// (cleared shortly after a successful mount) stops a genuinely broken deploy
// from reload-looping.
window.addEventListener("vite:preloadError", () => {
  if (sessionStorage.getItem("vitePreloadReloaded")) return;
  sessionStorage.setItem("vitePreloadReloaded", "1");
  window.location.reload();
});
setTimeout(() => sessionStorage.removeItem("vitePreloadReloaded"), 10_000);

const queryClient = new QueryClient();

const redirectToLoginIfUnauthorized = (error: unknown) => {
  if (!(error instanceof TRPCClientError)) return;
  if (typeof window === "undefined") return;
  if (error.message !== UNAUTHED_ERR_MSG) return;
  if (isLoggingOut()) return;
  startLogin();
};

queryClient.getQueryCache().subscribe(event => {
  if (event.type === "updated" && event.action.type === "error") {
    redirectToLoginIfUnauthorized(event.query.state.error);
  }
});

queryClient.getMutationCache().subscribe(event => {
  if (event.type === "updated" && event.action.type === "error") {
    redirectToLoginIfUnauthorized(event.mutation.state.error);
  }
});

const trpcClient = trpc.createClient({
  links: [
    httpBatchLink({
      url: "/api/trpc",
      transformer: superjson,
      headers() {
        try {
          const raw = sessionStorage.getItem("manus-cookie");
          if (raw) {
            const prefix = `${COOKIE_NAME}=`;
            const pair = raw.split(";").find(s => s.trim().startsWith(prefix));
            const token = pair?.trim().slice(prefix.length);
            if (token) return { Authorization: `Bearer ${token}` };
          }
        } catch {
          // sessionStorage unavailable
        }
        return {};
      },
      fetch(input, init) {
        return globalThis.fetch(input, { ...(init ?? {}), credentials: "include" });
      },
    }),
  ],
});

createRoot(document.getElementById("root")!).render(
  <trpc.Provider client={trpcClient} queryClient={queryClient}>
    <QueryClientProvider client={queryClient}>
      <TenantProvider>
        <App />
      </TenantProvider>
    </QueryClientProvider>
  </trpc.Provider>
);
