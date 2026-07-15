import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
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
 *  2. Calls keycloak.exchangeCode to exchange the code for tokens server-side
 *  3. Stores the resulting portal session token in localStorage
 *  4. Redirects to /portal (the portal dashboard)
 *
 * The `state` param encodes the tenantId as a base64 JSON blob so we know
 * which tenant's Keycloak config to use for the token exchange.
 */
export default function SsoCallback() {
  const [, navigate] = useLocation();
  const [status, setStatus] = useState<"exchanging" | "success" | "error">("exchanging");
  const [errorMsg, setErrorMsg] = useState("");
  const [tenantName, setTenantName] = useState("");

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

    // Decode tenantId from state (encoded as base64 JSON by TenantPortalLayout)
    let tenantId = "";
    if (state) {
      try {
        const decoded = JSON.parse(atob(state)) as { tenantId?: string };
        tenantId = decoded.tenantId ?? "";
      } catch {
        // state may be a plain string in some flows
        tenantId = state;
      }
    }

    if (!tenantId) {
      setStatus("error");
      setErrorMsg(
        "Could not determine tenant from SSO state. Please try logging in again."
      );
      return;
    }

    const redirectUri = `${window.location.origin}/portal/sso-callback`;
    exchangeMutation.mutate({ tenantId, code, redirectUri, state: state ?? undefined });
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
