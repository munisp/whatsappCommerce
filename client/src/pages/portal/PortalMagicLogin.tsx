import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { CheckCircle, XCircle, MessageSquare } from "lucide-react";

/**
 * Portal Magic Link Login Page
 * ==============================
 * Route: /portal/login#token=<jwt>   (preferred, W47 ONB-TOK-2)
 *        /portal/login?token=<jwt>   (legacy links still accepted)
 *
 * W47 crosscutting (ONB-TOK-2): new invite links carry the token in the URL
 * FRAGMENT so it never lands in access logs, browser history server-side, or
 * Referer headers. The fragment is read here, then immediately scrubbed from
 * the address bar via history.replaceState.
 *
 * Validates the invite token and stores a portal session token in
 * localStorage, then redirects to /portal.
 */
export default function PortalMagicLogin() {
  const [, navigate] = useLocation();
  const [status, setStatus] = useState<"validating" | "success" | "error">("validating");
  const [errorMsg, setErrorMsg] = useState("");
  const [tenantName, setTenantName] = useState("");

  const validateMutation = trpc.tenantInvite.validate.useMutation({
    onSuccess(data) {
      if (data.valid && data.sessionToken) {
        localStorage.setItem("portal_session_token", data.sessionToken);
        localStorage.setItem("portal_tenant_id", data.tenantId ?? "");
        localStorage.setItem("portal_tenant_name", data.tenantName ?? "");
        setTenantName(data.tenantName ?? "");
        setStatus("success");
        setTimeout(() => navigate("/portal"), 1500);
      } else {
        setStatus("error");
        setErrorMsg(data.error ?? "Invalid or expired link");
      }
    },
    onError(err) {
      setStatus("error");
      setErrorMsg(err.message);
    },
  });

  useEffect(() => {
    // === W47 stakeholders === ONB-S-15: the token rides the URL FRAGMENT
    // (#token=) so it never lands in access logs / browser history /
    // Referer headers. The legacy ?token= query param is still honored for
    // links minted before W47.
    const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const params = new URLSearchParams(window.location.search);
    const token = hashParams.get("token") ?? params.get("token");
    // === END W47 stakeholders ===
    if (!token) {
      setStatus("error");
      setErrorMsg("No invite token found in the URL.");
      return;
    }
    // Scrub the credential from the address bar/history immediately.
    window.history.replaceState(null, "", window.location.pathname);
    validateMutation.mutate({ token });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="min-h-screen bg-gradient-to-br from-green-50 to-emerald-100 flex items-center justify-center p-4">
      <Card className="w-full max-w-md shadow-xl">
        <CardHeader className="text-center">
          <div className="mx-auto mb-3 w-12 h-12 rounded-full bg-green-100 flex items-center justify-center">
            <MessageSquare className="w-6 h-6 text-green-600" />
          </div>
          <CardTitle className="text-xl">WhatsApp Commerce Portal</CardTitle>
        </CardHeader>
        <CardContent className="text-center space-y-4">
          {status === "validating" && (
            <>
              <Spinner className="mx-auto" />
              <p className="text-muted-foreground">Validating your invite link…</p>
            </>
          )}
          {status === "success" && (
            <>
              <CheckCircle className="mx-auto w-12 h-12 text-green-500" />
              <p className="font-semibold text-green-700">Welcome, {tenantName}!</p>
              <p className="text-muted-foreground text-sm">Redirecting to your dashboard…</p>
            </>
          )}
          {status === "error" && (
            <>
              <XCircle className="mx-auto w-12 h-12 text-red-500" />
              <p className="font-semibold text-red-700">Link Invalid or Expired</p>
              <p className="text-muted-foreground text-sm">{errorMsg}</p>
              <Button variant="outline" onClick={() => navigate("/")}>
                Go to Home
              </Button>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
