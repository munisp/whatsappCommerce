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
 * Route: /portal/login?token=<jwt>
 *
 * Validates the invite token and stores a portal session token in
 * localStorage, then redirects to /portal/dashboard.
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
        setTimeout(() => navigate("/portal/dashboard"), 1500);
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
    const params = new URLSearchParams(window.location.search);
    const token = params.get("token");
    if (!token) {
      setStatus("error");
      setErrorMsg("No invite token found in the URL.");
      return;
    }
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
