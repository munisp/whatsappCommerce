import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { consumeSsoTransaction, ssoFailureMessage } from "@/lib/ssoTransaction";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { CheckCircle, XCircle, ShieldCheck } from "lucide-react";

/**
 * Keycloak SSO Callback Page
 * ===========================
 * Route: /portal/sso-callback?code=<auth_code>&state=<state>
 *
 * After Keycloak redirects back here with an authorization code, this page:
 *  1. Reads the `code` and `state` query params
 *  2. Checks `state` against the transaction THIS TAB started (QA-039) — a callback this tab did not start is
 *     refused before anything is sent to the server (login CSRF)
 *  3. Calls keycloak.exchangeCode with the PKCE verifier kept by this tab, so Keycloak can refuse a code that was
 *     issued for a different browser
 *  4. Stores the resulting portal session token in localStorage
 *  5. Redirects to /portal (the portal dashboard)
 *
 * The tenant comes from the stored transaction, NOT from the URL: nothing in the query string is trusted.
 */
export default function SsoCallback() {
  const [, navigate] = useLocation();
  const [status, setStatus] = useState<"exchanging" | "success" | "error">("exchanging");
  const [errorMsg, setErrorMsg] = useState("");
  const [tenantName, setTenantName] = useState("");
  const startedRef = useRef(false);

  const exchangeMutation = trpc.keycloak.exchangeCode.useMutation({
    onSuccess(data) {
      localStorage.setItem("portal_session_token", data.sessionToken);
      localStorage.setItem("portal_tenant_id", data.tenantId);
      localStorage.setItem("portal_tenant_name", data.tenantName);
      setTenantName(data.tenantName);
      setStatus("success");
      setTimeout(() => navigate("/portal"), 1800);
    },
    onError(err) {
      setStatus("error");
      setErrorMsg(err.message);
    },
  });

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const state = params.get("state");
    const error = params.get("error");
    const errorDescription = params.get("error_description");

    if (error) {
      setStatus("error");
      setErrorMsg(errorDescription ?? error);
      return;
    }

    if (!code) {
      setStatus("error");
      setErrorMsg("No authorization code received from Keycloak.");
      return;
    }

    // Single use: consuming removes the stored transaction, so this must run exactly once (React StrictMode runs
    // effects twice in dev — the second run would find nothing and show a spurious failure).
    if (startedRef.current) return;
    startedRef.current = true;

    const tx = consumeSsoTransaction(state);
    if (!tx.ok) {
      setStatus("error");
      setErrorMsg(ssoFailureMessage(tx.reason));
      return;
    }

    const redirectUri = `${window.location.origin}/portal/sso-callback`;
    exchangeMutation.mutate({
      tenantId: tx.tenantId,
      code,
      redirectUri,
      state: state ?? undefined,
      codeVerifier: tx.codeVerifier,
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-100 flex items-center justify-center p-4">
      <Card className="w-full max-w-md shadow-xl">
        <CardHeader className="text-center">
          <div className="mx-auto mb-3 w-12 h-12 rounded-full bg-indigo-100 flex items-center justify-center">
            <ShieldCheck className="w-6 h-6 text-indigo-600" />
          </div>
          <CardTitle className="text-xl">SSO Login</CardTitle>
        </CardHeader>
        <CardContent className="text-center space-y-4">
          {status === "exchanging" && (
            <>
              <Spinner className="mx-auto" />
              <p className="text-muted-foreground">Completing SSO login…</p>
              <p className="text-xs text-muted-foreground">
                Exchanging authorization code with Keycloak
              </p>
            </>
          )}
          {status === "success" && (
            <>
              <CheckCircle className="mx-auto w-12 h-12 text-green-500" />
              <p className="font-semibold text-green-700">
                Welcome{tenantName ? `, ${tenantName}` : ""}!
              </p>
              <p className="text-muted-foreground text-sm">
                SSO login successful. Redirecting to your portal…
              </p>
            </>
          )}
          {status === "error" && (
            <>
              <XCircle className="mx-auto w-12 h-12 text-red-500" />
              <p className="font-semibold text-red-700">SSO Login Failed</p>
              <p className="text-muted-foreground text-sm">{errorMsg}</p>
              <div className="flex gap-2 justify-center">
                <Button variant="outline" onClick={() => navigate("/portal")}>
                  Back to Portal
                </Button>
                <Button
                  onClick={() => {
                    setStatus("exchanging");
                    setErrorMsg("");
                    window.location.reload();
                  }}
                >
                  Retry
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
