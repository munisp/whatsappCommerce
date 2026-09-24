import React from "react";
import { useAuth } from "@/_core/hooks/useAuth";
import { Badge } from "@/components/ui/badge";
import { Shield } from "lucide-react";

// Client-side companion to the server's adminProcedure gate. The server is
// the real authorization boundary — this only stops a non-admin's page from
// silently rendering an empty-looking dashboard (every query 403s, but pages
// that only branch on isLoading vs. !data?.length can't tell that apart from
// "no data yet"), which reads as "I have access" even though no data loaded.
export function AdminGuard({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading || !user) return <div className="p-8 text-center text-muted-foreground">Loading...</div>;
  if (user.role !== "admin") {
    return (
      <div className="p-8 text-center">
        <Shield className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
        <h2 className="text-xl font-semibold mb-2">Access Restricted</h2>
        <p className="text-muted-foreground">This page requires administrator privileges.</p>
        <Badge variant="outline" className="mt-2">Your role: {user.role}</Badge>
      </div>
    );
  }
  return <>{children}</>;
}
