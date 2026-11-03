import { Link, useLocation } from "wouter";
import { OakSignIn } from "@/components/OakSignIn";
import { useAuth } from "@/_core/hooks/useAuth";
import { startLogin } from "@/const";
import { Button } from "@/components/ui/button";
import {
  LayoutDashboard, Package, ShoppingCart, FileText,
  Settings, CreditCard, MessageSquare, LogOut, Building2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useState } from "react";
import { toast } from "sonner";
import { beginSsoTransaction } from "@/lib/ssoTransaction";
import NotificationCenter from "@/components/NotificationCenter";
import { Wallet, Rocket, BarChart3, Megaphone, MapPin, BookOpen } from "lucide-react";
import { displayNameFor } from "@/lib/tenantAccess";

const NAV = [
  { label: "Dashboard", path: "/portal", icon: LayoutDashboard },
  { label: "Products", path: "/portal/products", icon: Package },
  { label: "Orders", path: "/portal/orders", icon: ShoppingCart },
  { label: "Conversations", path: "/portal/conversations", icon: MessageSquare },
  { label: "Invoices", path: "/portal/invoices", icon: FileText },
  { label: "Payments", path: "/portal/payments", icon: CreditCard },
  { label: "Wallet", path: "/portal/wallet", icon: Wallet },
  { label: "Analytics", path: "/portal/analytics", icon: BarChart3 },
  // === W27 bookkeeping ===
  { label: "Bookkeeping", path: "/portal/bookkeeping", icon: BookOpen },
  { label: "Broadcasts", path: "/portal/broadcasts", icon: Megaphone },
  { label: "Setup Wizard", path: "/portal/setup", icon: Rocket },
  { label: "Discovery", path: "/settings/discovery", icon: MapPin },
  { label: "Settings", path: "/portal/settings", icon: Settings },
];

export function TenantPortalLayout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { user, logout } = useAuth();
  const [tenantId, setTenantId] = useState("");
  const [ssoLoading, setSsoLoading] = useState(false);

  const handleSsoLogin = async () => {
    if (!tenantId.trim()) {
      toast.error("Please enter your Tenant ID to use SSO login");
      return;
    }
    setSsoLoading(true);
    try {
      const redirectUri = `${window.location.origin}/portal/sso-callback`;
      // QA-039: an unguessable state + PKCE challenge, remembered in THIS tab so the callback can prove it belongs
      // to the login this tab started (see lib/ssoTransaction.ts).
      const { state, codeChallenge } = await beginSsoTransaction(tenantId);
      const res = await fetch(
        `/api/trpc/keycloak.getLoginUrl?batch=1&input=${encodeURIComponent(JSON.stringify({ "0": { json: { tenantId, redirectUri, state, codeChallenge } } }))}`,
        { headers: { Accept: "application/json" } }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as Array<{ result: { data: { json: { authUrl: string } } } }>;
      const authUrl = data[0]?.result?.data?.json?.authUrl;
      if (!authUrl) throw new Error("No auth URL returned — Keycloak may not be configured for this tenant");
      window.location.href = authUrl;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("not configured") || msg.includes("not found") || msg.includes("disabled")) {
        toast.info("SSO not configured for this tenant — using standard login");
        startLogin();
      } else {
        toast.error(`SSO error: ${msg}`);
      }
    } finally {
      setSsoLoading(false);
    }
  };

  if (!user) {
    return (
      <OakSignIn title="Merchant Portal" description="Sign in to manage your store, orders and customers on OAK." photo="boutique-owner" alt="A boutique owner among the clothes in his shop">
          {/* Keycloak SSO section */}
          <div className="mt-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="flex-1 h-px bg-muted" />
              <span className="text-slate-500 text-xs">or sign in with SSO</span>
              <div className="flex-1 h-px bg-muted" />
            </div>
            <div className="flex gap-2">
              <input
                type="text"
                placeholder="Tenant ID"
                value={tenantId}
                onChange={e => setTenantId(e.target.value)}
                onKeyDown={e => e.key === "Enter" && handleSsoLogin()}
                className="flex-1 bg-muted border border-border rounded-lg px-3 py-2 text-foreground text-sm placeholder-slate-500 focus:outline-none focus:border-emerald-500 transition-colors"
              />
              <Button
                variant="outline"
                className="border-border text-foreground hover:bg-muted hover:text-white bg-transparent"
                onClick={handleSsoLogin}
                disabled={ssoLoading}
              >
                {ssoLoading ? "…" : "SSO →"}
              </Button>
            </div>
            <p className="text-slate-600 text-xs mt-2">
              Enter your tenant ID to redirect to your organisation's Keycloak login
            </p>
          </div>
          <p className="mt-6 text-xs text-slate-500">
            Not a merchant yet?{" "}
            <Link href="/onboarding-wizard" className="text-emerald-400 hover:underline">
              Start onboarding
            </Link>
          </p>
      </OakSignIn>
    );
  }

  return (
    <div className="flex h-screen bg-card text-foreground overflow-hidden">
      {/* Sidebar */}
      <aside className="w-60 flex-shrink-0 bg-card border-r border-border flex flex-col">
        <div className="p-5 border-b border-border">
          <div className="flex items-center gap-3">
            <div className="bg-emerald-500/20 p-2 rounded-lg">
              <Building2 className="h-5 w-5 text-emerald-400" />
            </div>
            <div>
              <p className="text-sm font-semibold text-foreground">Merchant Portal</p>
              {/* QA-043: this used to show `user.name ?? user.openId` — for a newly registered person with no display name that is
                  the identity provider's raw UUID. displayNameFor falls back to the email's local part, never an internal id. */}
              <p className="text-xs text-foreground truncate max-w-[140px]" data-testid="portal-account-name">{displayNameFor(user)}</p>
              {user.email && <p className="text-[11px] text-slate-500 truncate max-w-[140px]" data-testid="portal-account-email">{user.email}</p>}
            </div>
          </div>
        </div>
        <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
          {NAV.map(({ label, path, icon: Icon }) => (
            <Link key={path} href={path}>
              <div className={cn(
                "flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium cursor-pointer transition-colors",
                location === path
                  ? "bg-emerald-600 text-white"
                  : "text-slate-400 hover:bg-muted hover:text-white",
              )}>
                <Icon className="h-4 w-4 flex-shrink-0" />
                {label}
              </div>
            </Link>
          ))}
        </nav>
        <div className="p-3 border-t border-border">
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start text-slate-400 hover:text-white hover:bg-muted"
            onClick={() => logout()}
          >
            <LogOut className="h-4 w-4 mr-2" />
            Sign out
          </Button>
        </div>
      </aside>
      {/* Main content */}
      <main className="flex-1 overflow-y-auto flex flex-col">
        {/* Portal top bar with notification bell */}
        <div className="flex items-center justify-end px-6 py-3 border-b border-border bg-card/50">
          <NotificationCenter />
        </div>
        <div className="flex-1 overflow-y-auto p-6">{children}</div>
      </main>
    </div>
  );
}
