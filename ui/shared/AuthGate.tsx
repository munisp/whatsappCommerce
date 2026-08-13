/**
 * AuthGate — shared entry-point guard for both ui/platform-admin and
 * ui/tenant-portal. Blocks rendering of the app's routes until the session
 * is resolved, then enforces the caller-supplied `allow` predicate against
 * the authenticated user (role / tenant membership / etc).
 *
 * This is a UI convenience, not the security boundary — the real boundary
 * is the tRPC procedure guards (adminProcedure, tenantAdminProcedure,
 * assertTenantAccess) on the server. This just avoids flashing the wrong
 * app's UI at the wrong audience.
 */
import type { ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/_core/hooks/useAuth";
import { startLogin } from "@/const";

type AuthUser = NonNullable<ReturnType<typeof useAuth>["user"]>;

type AuthGateProps = {
  children: ReactNode;
  allow: (user: AuthUser) => boolean;
  deniedTitle?: string;
  deniedMessage?: string;
};

export function AuthGate({ children, allow, deniedTitle, deniedMessage }: AuthGateProps) {
  const { user, loading, isAuthenticated } = useAuth();

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!isAuthenticated || !user) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="flex flex-col items-center gap-6 p-8 max-w-md w-full text-center">
          <h1 className="text-2xl font-semibold tracking-tight">Sign in to continue</h1>
          <p className="text-sm text-muted-foreground">
            Access to this application requires an authenticated account.
          </p>
          <Button onClick={() => startLogin()} size="lg" className="w-full">
            Sign In
          </Button>
        </div>
      </div>
    );
  }

  if (!allow(user)) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="flex flex-col items-center gap-3 p-8 max-w-md w-full text-center">
          <h1 className="text-2xl font-semibold tracking-tight">
            {deniedTitle ?? "Access denied"}
          </h1>
          <p className="text-sm text-muted-foreground">
            {deniedMessage ?? "You don't have permission to view this application."}
          </p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
