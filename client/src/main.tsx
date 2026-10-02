import { trpc } from "@/lib/trpc";
import { COOKIE_NAME, UNAUTHED_ERR_MSG } from '@shared/const';
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink, TRPCClientError } from "@trpc/client";
import { createRoot } from "react-dom/client";
import superjson from "superjson";
// === W48 perf (PERF-FE-6): self-hosted fonts (latin subsets, no italics) ===
// Replaces the render-blocking Google Fonts stylesheet in index.html.
import "@fontsource/inter/latin-400.css";
import "@fontsource/inter/latin-500.css";
import "@fontsource/inter/latin-600.css";
import "@fontsource/inter/latin-700.css";
import "@fontsource/jetbrains-mono/latin-400.css";
import "@fontsource/jetbrains-mono/latin-500.css";
// Preload the primary text face so first paint doesn't wait on CSS discovery.
import inter400Url from "@fontsource/inter/files/inter-latin-400-normal.woff2?url";
import App from "./App";
import { isLoggingOut, startLogin } from "./const";
import "./index.css";
import { TenantProvider } from "./contexts/TenantContext";

{
  const pre = document.createElement("link");
  pre.rel = "preload";
  pre.as = "font";
  pre.type = "font/woff2";
  pre.crossOrigin = "anonymous";
  pre.href = inter400Url;
  document.head.appendChild(pre);
}

// === W48 perf (PERF-FE-1): register the PWA service worker (autoUpdate). ===
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  import("virtual:pwa-register")
    .then(({ registerSW }) => registerSW({ immediate: true }))
    .catch(() => {
      /* SW registration is best-effort telemetry-wise: fail open */
    });
}

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

// === W48 perf (PERF-FE-3): sane react-query defaults — data is treated as
// fresh for 30s and queries no longer all refire on every window focus. ===
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
  },
});

const redirectToLoginIfUnauthorized = (error: unknown) => {
  if (!(error instanceof TRPCClientError)) return;
  if (typeof window === "undefined") return;

  const isUnauthorized = error.message === UNAUTHED_ERR_MSG;

  if (!isUnauthorized) return;
  if (isLoggingOut()) return;

  startLogin();
};

queryClient.getQueryCache().subscribe(event => {
  if (event.type === "updated" && event.action.type === "error") {
    const error = event.query.state.error;
    redirectToLoginIfUnauthorized(error);
    console.error("[API Query Error]", error);
  }
});

queryClient.getMutationCache().subscribe(event => {
  if (event.type === "updated" && event.action.type === "error") {
    const error = event.mutation.state.error;
    redirectToLoginIfUnauthorized(error);
    console.error("[API Mutation Error]", error);
  }
});

const trpcClient = trpc.createClient({
  links: [
    httpBatchLink({
      url: "/api/trpc",
      transformer: superjson,
      headers() {
        // === W60 persistence (documented, kept as-is) ===
        // sessionStorage "manus-cookie" Bearer fallback — INTENTIONAL.
        // Preview auto-login fallback: when the browser blocks iframe cookies
        // (Safari ITP / private browsing / WebView), the runtime mirrors the
        // session into sessionStorage so we can forward it as a Bearer token.
        // The regular OAuth cookie flow keeps working and takes priority
        // server-side (cookie auth is checked before the Bearer header), so
        // this path only activates where cookies are already blocked.
        // NOTE: the W60 portal_session httpOnly cookie (tenantInvite.validate
        // / keycloak.exchangeCode) is unrelated to this flow — portal tokens
        // no longer touch localStorage; this sessionStorage shim stays for
        // the core app session under Safari ITP.
        try {
          const raw = sessionStorage.getItem("manus-cookie");
          if (raw) {
            const prefix = `${COOKIE_NAME}=`;
            const pair = raw.split(";").find(s => s.trim().startsWith(prefix));
            const token = pair?.trim().slice(prefix.length);
            if (token) {
              return { Authorization: `Bearer ${token}` };
            }
          }
        } catch {
          // sessionStorage unavailable
        }
        return {};
      },
      fetch(input, init) {
        return globalThis.fetch(input, {
          ...(init ?? {}),
          credentials: "include",
        });
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
