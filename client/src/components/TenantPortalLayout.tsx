import { Link, useLocation } from "wouter";
import { useAuth } from "@/_core/hooks/useAuth";
import { startLogin } from "@/const";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";
import {
  LayoutDashboard, Package, ShoppingCart, FileText,
  Settings, CreditCard, MessageSquare, LogOut, Building2,
} from "lucide-react";
import { cn } from "@/lib/utils";

const NAV = [
  { label: "Dashboard", path: "/portal", icon: LayoutDashboard },
  { label: "Products", path: "/portal/products", icon: Package },
  { label: "Orders", path: "/portal/orders", icon: ShoppingCart },
  { label: "Conversations", path: "/portal/conversations", icon: MessageSquare },
  { label: "Invoices", path: "/portal/invoices", icon: FileText },
  { label: "Payments", path: "/portal/payments", icon: CreditCard },
  { label: "Settings", path: "/portal/settings", icon: Settings },
];

export function TenantPortalLayout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { user } = useAuth();
  const logoutMutation = trpc.auth.logout.useMutation({ onSuccess: () => window.location.href = "/portal" });

  if (!user) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-emerald-950 to-slate-900">
        <div className="bg-slate-800 border border-slate-700 rounded-2xl p-10 w-full max-w-md text-center shadow-2xl">
          <div className="flex justify-center mb-6">
            <div className="bg-emerald-500/20 p-4 rounded-full">
              <Building2 className="h-10 w-10 text-emerald-400" />
            </div>
          </div>
          <h1 className="text-2xl font-bold text-white mb-2">Merchant Portal</h1>
          <p className="text-slate-400 mb-8 text-sm">
            Sign in to manage your store, orders, and customers on the WhatsApp Commerce platform.
          </p>
          <Button
            className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-semibold py-3"
            onClick={() => startLogin()}
          >
            Sign in with Manus
          </Button>
          <p className="mt-6 text-xs text-slate-500">
            Not a merchant yet?{" "}
            <Link href="/onboarding" className="text-emerald-400 hover:underline">
              Start onboarding
            </Link>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-slate-900 text-slate-100 overflow-hidden">
      {/* Sidebar */}
      <aside className="w-60 flex-shrink-0 bg-slate-800 border-r border-slate-700 flex flex-col">
        <div className="p-5 border-b border-slate-700">
          <div className="flex items-center gap-3">
            <div className="bg-emerald-500/20 p-2 rounded-lg">
              <Building2 className="h-5 w-5 text-emerald-400" />
            </div>
            <div>
              <p className="text-sm font-semibold text-white">Merchant Portal</p>
              <p className="text-xs text-slate-400 truncate max-w-[120px]">{user.name ?? user.openId}</p>
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
                  : "text-slate-400 hover:bg-slate-700 hover:text-white",
              )}>
                <Icon className="h-4 w-4 flex-shrink-0" />
                {label}
              </div>
            </Link>
          ))}
        </nav>
        <div className="p-3 border-t border-slate-700">
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start text-slate-400 hover:text-white hover:bg-slate-700"
            onClick={() => logoutMutation.mutate()}
          >
            <LogOut className="h-4 w-4 mr-2" />
            Sign out
          </Button>
        </div>
      </aside>
      {/* Main content */}
      <main className="flex-1 overflow-y-auto p-6">{children}</main>
    </div>
  );
}
