import { useState } from "react";
import { trpc } from "@/lib/trpc";
import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Shield, Search, Users, LogIn, Clock } from "lucide-react";

function initials(name?: string | null, email?: string | null): string {
  if (name) return name.split(" ").map((p) => p[0]).join("").toUpperCase().slice(0, 2);
  if (email) return email[0].toUpperCase();
  return "?";
}

function timeAgo(date: Date | string | null): string {
  if (!date) return "—";
  const ms = Date.now() - new Date(date).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

export default function SsoUsers() {
  const [search, setSearch] = useState("");

  const { data, isLoading } = trpc.keycloak.listSsoProfiles.useQuery(
    { search: search || undefined, limit: 100 },
    { refetchInterval: 30_000 }
  );

  const profiles = data?.profiles ?? [];

  return (
    <DashboardLayout>
      <div className="p-6 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <Shield className="h-6 w-6 text-primary" />
              SSO Users
            </h1>
            <p className="text-muted-foreground text-sm mt-1">
              Tenants who have authenticated via Keycloak SSO. Profiles are provisioned automatically on first login.
            </p>
          </div>
          <Badge variant="secondary" className="text-base px-3 py-1">
            <Users className="h-4 w-4 mr-1" />
            {isLoading ? "…" : profiles.length} users
          </Badge>
        </div>

        {/* Stats row */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <Card>
            <CardContent className="pt-5">
              <p className="text-xs text-muted-foreground uppercase tracking-wide">Total SSO Users</p>
              <p className="text-3xl font-bold mt-1">{isLoading ? "—" : profiles.length}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-5">
              <p className="text-xs text-muted-foreground uppercase tracking-wide">Total Logins</p>
              <p className="text-3xl font-bold mt-1">
                {isLoading ? "—" : profiles.reduce((s, p) => s + (p.ssoLoginCount ?? 0), 0)}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-5">
              <p className="text-xs text-muted-foreground uppercase tracking-wide">Active (last 7d)</p>
              <p className="text-3xl font-bold mt-1">
                {isLoading
                  ? "—"
                  : profiles.filter((p) => {
                      if (!p.lastSsoLoginAt) return false;
                      return Date.now() - new Date(p.lastSsoLoginAt).getTime() < 7 * 86400_000;
                    }).length}
              </p>
            </CardContent>
          </Card>
        </div>

        {/* Search */}
        <div className="relative max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            className="pl-9"
            placeholder="Search by name, email, or tenant…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        {/* Profile cards */}
        <Card>
          <CardHeader>
            <CardTitle>Provisioned Profiles</CardTitle>
            <CardDescription>
              Each row represents a tenant whose SSO login has been processed at least once.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="space-y-3">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-14 w-full rounded-lg" />
                ))}
              </div>
            ) : profiles.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground">
                <Shield className="h-10 w-10 mx-auto mb-3 opacity-30" />
                <p className="font-medium">No SSO users yet</p>
                <p className="text-sm mt-1">
                  Profiles appear here after a tenant completes their first Keycloak SSO login.
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-muted-foreground">
                      <th className="text-left py-2 pr-4 font-medium">User</th>
                      <th className="text-left py-2 pr-4 font-medium">Tenant</th>
                      <th className="text-left py-2 pr-4 font-medium">Provider</th>
                      <th className="text-right py-2 pr-4 font-medium">
                        <LogIn className="h-3.5 w-3.5 inline mr-1" />
                        Logins
                      </th>
                      <th className="text-right py-2 pr-4 font-medium">First Login</th>
                      <th className="text-right py-2 font-medium">
                        <Clock className="h-3.5 w-3.5 inline mr-1" />
                        Last Login
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {profiles.map((p) => (
                      <tr key={p.tenantId} className="border-b last:border-0 hover:bg-muted/30 transition-colors">
                        <td className="py-3 pr-4">
                          <div className="flex items-center gap-2">
                            <Avatar className="h-8 w-8">
                              <AvatarFallback className="text-xs bg-primary/10 text-primary">
                                {initials(p.ssoName, p.ssoEmail)}
                              </AvatarFallback>
                            </Avatar>
                            <div>
                              <p className="font-medium leading-tight">{p.ssoName ?? "—"}</p>
                              <p className="text-xs text-muted-foreground">{p.ssoEmail ?? "—"}</p>
                            </div>
                          </div>
                        </td>
                        <td className="py-3 pr-4">
                          <span className="font-medium">{p.tenantName ?? p.tenantId}</span>
                          <p className="text-xs text-muted-foreground font-mono">{p.tenantId.slice(0, 8)}…</p>
                        </td>
                        <td className="py-3 pr-4">
                          <Badge variant="outline" className="capitalize">
                            {p.ssoProvider ?? "keycloak"}
                          </Badge>
                        </td>
                        <td className="py-3 pr-4 text-right font-mono font-semibold">
                          {p.ssoLoginCount ?? 0}
                        </td>
                        <td className="py-3 pr-4 text-right text-muted-foreground text-xs">
                          {p.firstSsoLoginAt
                            ? new Date(p.firstSsoLoginAt).toLocaleDateString()
                            : "—"}
                        </td>
                        <td className="py-3 text-right">
                          <span className="text-xs text-muted-foreground">{timeAgo(p.lastSsoLoginAt)}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
