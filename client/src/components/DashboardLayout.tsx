import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { startLogin } from "@/const";
import { useIsMobile } from "@/hooks/useMobile";
import {
  LayoutDashboard, LogOut, Package, MessageSquare, BarChart3,
  CreditCard, Settings, Users, ShoppingBag, Bell, FileText, Globe,
  Zap, TrendingUp, Shield, Store, Truck, ChevronRight, ChevronDown,
  Search, Bot, Megaphone, FileCode, GitMerge, MessagesSquare,
  BrainCircuit, Warehouse, Smartphone, Link2,
  Database, GitBranch, AlertTriangle, Activity, Lock, Network,
  UserPlus, Rocket, KeyRound, Building2, ScrollText,
  Paperclip, BarChart2, Cpu, Plug, SlidersHorizontal, Map, HeartPulse,
  ClipboardCheck, ShoppingCart, ShieldCheck, Wallet, Route,
} from "lucide-react";
import { CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { DashboardLayoutSkeleton } from "./DashboardLayoutSkeleton";
import { Button } from "./ui/button";
import NotificationCenter from "./NotificationCenter";
import { useActiveTenant } from "@/contexts/TenantContext";

type NavItem = {
  icon: React.ElementType;
  label: string;
  path: string;
};

type NavGroup = {
  id: string;
  label: string;
  icon: React.ElementType;
  items: NavItem[];
};

// This layout is shared by every page under client/src/pages (via the `@`
// alias) across all three surfaces — the legacy combined client, the
// standalone ui/tenant-portal, and ui/platform-admin. Which nav config
// renders is decided purely by which app is currently running (IS_PLATFORM_ADMIN,
// below), not by role — role only gates *entry* to platform-admin (AuthGate in
// ui/platform-admin/src/App.tsx), so nav content must never assume role alone
// distinguishes the two audiences. Every path here must exist as a route in
// that surface's own App.tsx or it's a dead link — see ui/tenant-portal/ROUTES.md
// and ui/platform-admin/ROUTES.md for the placement reasoning per item.
const TENANT_NAV_GROUPS: NavGroup[] = [
  {
    id: "overview",
    label: "Overview",
    icon: LayoutDashboard,
    items: [
      { icon: LayoutDashboard, label: "Dashboard",       path: "/portal" },
    ],
  },
  {
    id: "commerce",
    label: "Commerce & Catalog",
    icon: ShoppingBag,
    items: [
      { icon: Package,         label: "Products",        path: "/products" },
      { icon: Smartphone,      label: "WhatsApp Menu",   path: "/menu-builder" },
      { icon: Warehouse,       label: "Inventory",       path: "/inventory" },
      { icon: Store,           label: "Sales Channels",  path: "/sales-channels" },
    ],
  },
  {
    id: "supply-chain",
    label: "Supply Chain",
    icon: Store,
    items: [
      { icon: Store,           label: "Supplier Directory", path: "/suppliers" },
      { icon: ShoppingCart,    label: "Procurement Hub",    path: "/procurement" },
      { icon: CreditCard,      label: "Credit Accounts",    path: "/credit-accounts" },
      { icon: ClipboardCheck,  label: "PO Approvals",       path: "/supplier-approvals" },
      { icon: CreditCard,      label: "Manufacturer Credit", path: "/manufacturer-credit" },
    ],
  },
  {
    id: "messaging",
    label: "Conversations & Messaging",
    icon: MessagesSquare,
    items: [
      { icon: MessageSquare,   label: "Conversations",   path: "/conversations" },
      { icon: Globe,           label: "Multi-Channel",   path: "/multi-channel" },
      { icon: Megaphone,       label: "Broadcasts",      path: "/broadcast" },
      { icon: MessageSquare,   label: "Templates",       path: "/templates" },
      { icon: FileCode,        label: "WA Templates",    path: "/wa-templates" },
      { icon: FileCode,        label: "Msg Templates",   path: "/operator-templates" },
      { icon: GitBranch,       label: "Version Control", path: "/template-versions" },
      { icon: Paperclip,       label: "WA Media",        path: "/whatsapp-media" },
      { icon: Route,           label: "Journeys",        path: "/journeys" },
      { icon: ShieldCheck,     label: "Consents",        path: "/consents" },
    ],
  },
  {
    id: "orders",
    label: "Orders & Fulfilment",
    icon: Truck,
    items: [
      { icon: BarChart3,       label: "Orders",          path: "/orders" },
      { icon: AlertTriangle,   label: "Disputes",        path: "/disputes" },
      { icon: Truck,           label: "COD & Offline",   path: "/cod" },
    ],
  },
  {
    id: "finance",
    label: "Payments & Finance",
    icon: CreditCard,
    items: [
      { icon: CreditCard,      label: "Payments",        path: "/payments" },
      { icon: Lock,            label: "Escrow",          path: "/escrow" },
      { icon: TrendingUp,      label: "Revenue",         path: "/revenue" },
      { icon: FileText,        label: "Invoices",        path: "/invoices" },
      { icon: Smartphone,      label: "Mobile Money",    path: "/mobile-money" },
      { icon: Wallet,          label: "Wallet",          path: "/portal/wallet" },
    ],
  },
  {
    id: "analytics",
    label: "Analytics",
    icon: BarChart3,
    items: [
      { icon: BarChart3,       label: "Analytics BI",    path: "/analytics-bi" },
      { icon: BarChart2,       label: "Merchant Analytics", path: "/portal/analytics" },
    ],
  },
  {
    id: "integrations",
    label: "Integrations",
    icon: Globe,
    items: [
      { icon: Globe,           label: "Integration Hub", path: "/integrations" },
      { icon: Activity,        label: "Integration Health", path: "/integration-health" },
      { icon: Users,           label: "Twenty CRM",      path: "/twenty-crm" },
      { icon: Users,           label: "CRM Pipeline",    path: "/crm" },
      { icon: Package,         label: "Odoo",            path: "/odoo-erp" },
      { icon: ShoppingBag,     label: "Medusa",          path: "/medusa" },
    ],
  },
  {
    id: "configuration",
    label: "Configuration",
    icon: SlidersHorizontal,
    items: [
      { icon: Rocket,          label: "Onboarding Wizard", path: "/onboarding-wizard" },
      { icon: Rocket,          label: "Store Setup",      path: "/portal/setup" },
      { icon: Bot,             label: "Copilot",          path: "/onboarding-copilot" },
      { icon: Plug,            label: "Integration Settings", path: "/integration-settings" },
      { icon: SlidersHorizontal, label: "Tenant Settings", path: "/tenant-settings" },
    ],
  },
];

// Platform-team-only tooling — reachable exclusively from ui/platform-admin.
// None of these paths exist in ui/tenant-portal's route table on purpose.
const PLATFORM_NAV_GROUPS: NavGroup[] = [
  {
    id: "overview",
    label: "Overview",
    icon: LayoutDashboard,
    items: [
      { icon: LayoutDashboard, label: "Admin Home",       path: "/" },
    ],
  },
  {
    id: "tenants",
    label: "Tenants",
    icon: Building2,
    items: [
      { icon: Building2,       label: "Tenants",          path: "/tenants" },
      { icon: BarChart2,       label: "Tenant Analytics", path: "/tenant-analytics" },
      { icon: UserPlus,        label: "Onboard Tenant",   path: "/onboarding" },
      { icon: Link2,           label: "Menu Assignment",  path: "/tenant-menus" },
    ],
  },
  {
    id: "identity",
    label: "Identity & Access",
    icon: Shield,
    items: [
      { icon: Shield,          label: "SSO Users",        path: "/sso-users" },
      { icon: KeyRound,        label: "Phone Auth",       path: "/phone-auth" },
      { icon: MessageSquare,   label: "WhatsApp Profile", path: "/whatsapp-profile" },
    ],
  },
  {
    id: "setup-compliance",
    label: "Setup & Compliance",
    icon: Settings,
    items: [
      { icon: Settings,        label: "Setup Wizard",     path: "/setup" },
      { icon: Rocket,          label: "Deploy Checklist", path: "/deploy-checklist" },
      { icon: Shield,          label: "Compliance/B2G",   path: "/compliance" },
      { icon: Shield,          label: "SOC2 Dashboard",   path: "/soc2" },
      { icon: ShieldCheck,     label: "KYB Review",       path: "/kyb-review" },
    ],
  },
  {
    id: "monitoring",
    label: "Monitoring",
    icon: HeartPulse,
    items: [
      { icon: Activity,        label: "Service Health",   path: "/health" },
      { icon: HeartPulse,      label: "System Health",    path: "/system-health" },
      { icon: Cpu,             label: "Infra Health",     path: "/infra-health" },
      { icon: Bell,            label: "Alert Rules",      path: "/alert-rules" },
      { icon: ScrollText,      label: "Audit Logs",       path: "/audit-logs" },
    ],
  },
  {
    id: "logistics",
    label: "Logistics",
    icon: Truck,
    items: [
      { icon: Truck,           label: "Logistics",        path: "/logistics" },
      { icon: Map,             label: "Live Map",         path: "/logistics-map" },
    ],
  },
  {
    id: "finance-ops",
    label: "Finance & Ops",
    icon: GitMerge,
    items: [
      { icon: GitMerge,        label: "Reconciliation",   path: "/reconciliation" },
      { icon: AlertTriangle,   label: "Webhook DLQ",      path: "/webhook-dlq" },
      { icon: AlertTriangle,   label: "COGS Disputes",    path: "/cogs-disputes" },
    ],
  },
  {
    id: "ai-tooling",
    label: "AI & Data Tooling",
    icon: BrainCircuit,
    items: [
      { icon: Bot,             label: "AI Agent",        path: "/agent" },
      { icon: Network,         label: "AI Architecture", path: "/agent-architecture" },
      { icon: ScrollText,      label: "Agent Events",    path: "/audit-log" },
      { icon: MessagesSquare,  label: "NLP Simulator",   path: "/nlp-simulator" },
      { icon: BrainCircuit,    label: "ML Ops",           path: "/ml-ops" },
      { icon: Database,        label: "Label Studio",     path: "/label-studio" },
      { icon: BarChart2,       label: "Scan Accuracy",    path: "/scan-stats" },
      { icon: Zap,             label: "Hermes Agent",     path: "/hermes" },
    ],
  },
];

// Which config renders is determined by the running app, not by role —
// BASE_URL only depends on the build `command` (see the .dockerignore/App.tsx
// NODE_ENV-leak fix), so it's a reliable signal at both build and runtime.
const IS_PLATFORM_ADMIN = import.meta.env.BASE_URL.includes("/platform-admin");

const SIDEBAR_WIDTH_KEY = "sidebar-width";
const NAV_EXPANDED_KEY = "nav-expanded-groups";
const DEFAULT_WIDTH = 280;
const MIN_WIDTH = 200;
const MAX_WIDTH = 480;

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = localStorage.getItem(SIDEBAR_WIDTH_KEY);
    return saved ? parseInt(saved, 10) : DEFAULT_WIDTH;
  });
  const { loading, user } = useAuth();

  useEffect(() => {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, sidebarWidth.toString());
  }, [sidebarWidth]);

  if (loading) {
    return <DashboardLayoutSkeleton />;
  }

  if (!user) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="flex flex-col items-center gap-8 p-8 max-w-md w-full">
          <div className="flex flex-col items-center gap-6">
            <h1 className="text-2xl font-semibold tracking-tight text-center">
              Sign in to continue
            </h1>
            <p className="text-sm text-muted-foreground text-center max-w-sm">
              Access to this dashboard requires an authenticated account.
            </p>
          </div>
          <Button
            onClick={() => startLogin()}
            size="lg"
            className="w-full shadow-lg hover:shadow-xl transition-all"
          >
            Sign in
          </Button>
        </div>
      </div>
    );
  }

  return (
    <SidebarProvider style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}>
      <DashboardLayoutContent setSidebarWidth={setSidebarWidth}>{children}</DashboardLayoutContent>
    </SidebarProvider>
  );
}

function NavGroup({
  group,
  location,
  setLocation,
  isCollapsed,
  searchQuery,
  open,
  onOpenChange,
}: {
  group: NavGroup;
  location: string;
  setLocation: (path: string) => void;
  isCollapsed: boolean;
  searchQuery: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const Icon = group.icon;

  const filteredItems = searchQuery
    ? group.items.filter(i => i.label.toLowerCase().includes(searchQuery.toLowerCase()))
    : group.items;

  const hasActiveItem = group.items.some(i => i.path === location);

  // While searching, matching groups are always shown expanded
  const effectiveOpen = searchQuery ? filteredItems.length > 0 : open;

  if (searchQuery && filteredItems.length === 0) return null;

  if (isCollapsed) {
    // Icon-only mode: render flat items with tooltips
    return (
      <SidebarMenu>
        {filteredItems.map(item => {
          const ItemIcon = item.icon;
          const isActive = location === item.path;
          return (
            <SidebarMenuItem key={item.path}>
              <SidebarMenuButton
                isActive={isActive}
                onClick={() => setLocation(item.path)}
                tooltip={item.label}
                className="h-10 transition-all font-normal"
              >
                <ItemIcon className="h-4 w-4" style={isActive ? { color: "hsl(var(--primary))" } : {}} />
              </SidebarMenuButton>
            </SidebarMenuItem>
          );
        })}
      </SidebarMenu>
    );
  }

  return (
    <Collapsible open={effectiveOpen} onOpenChange={onOpenChange} className="mb-1">
      <CollapsibleTrigger className="w-full">
        <div className={`flex items-center justify-between px-2 py-1.5 rounded-md text-xs font-semibold uppercase tracking-wider transition-colors hover:bg-accent/50 ${hasActiveItem ? "text-primary" : "text-muted-foreground"}`}>
          <div className="flex items-center gap-2">
            <Icon className="h-3.5 w-3.5" />
            <span>{group.label}</span>
          </div>
          {effectiveOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        </div>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <SidebarMenu className="mt-0.5">
          {filteredItems.map(item => {
            const ItemIcon = item.icon;
            const isActive = location === item.path;
            return (
              <SidebarMenuItem key={item.path}>
                <SidebarMenuButton
                  isActive={isActive}
                  onClick={() => setLocation(item.path)}
                  className="h-9 transition-all font-normal"
                >
                  <ItemIcon className="h-4 w-4" style={isActive ? { color: "hsl(var(--primary))" } : {}} />
                  <span>{item.label}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
      </CollapsibleContent>
    </Collapsible>
  );
}

function DashboardLayoutContent({
  children,
  setSidebarWidth,
}: {
  children: React.ReactNode;
  setSidebarWidth: (width: number) => void;
}) {
  const { user, logout } = useAuth();
  const [location, setLocation] = useLocation();
  const { state, toggleSidebar } = useSidebar();
  const isCollapsed = state === "collapsed";
  const [isResizing, setIsResizing] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const isMobile = useIsMobile();
  const { activeTenantId, setActiveTenantId } = useActiveTenant();
  // The caller's own tenant branding (name, logo, primary color) — applied to
  // the shell header. Meaningless in platform-admin (there's no single
  // "current tenant" to brand as).
  const { data: myTenant } = trpc.tenant.myTenant.useQuery(undefined, { enabled: !IS_PLATFORM_ADMIN });

  // A tenant user has exactly one tenant — the underlying localStorage-backed
  // TenantContext defaults to a placeholder id. Force it to the signed-in
  // user's own tenant outside platform-admin so a stale/placeholder value in
  // localStorage can never point these pages at someone else's data. (In
  // platform-admin, the handful of pages that need a specific tenant — e.g.
  // Logistics Tracker, Live Map — pick one locally, not via this shell.)
  useEffect(() => {
    if (IS_PLATFORM_ADMIN) return;
    if (user?.tenantId && user.tenantId !== activeTenantId) {
      setActiveTenantId(user.tenantId);
    }
  }, [user?.tenantId, activeTenantId, setActiveTenantId]);

  const visibleGroups = IS_PLATFORM_ADMIN ? PLATFORM_NAV_GROUPS : TENANT_NAV_GROUPS;
  const allItems = useMemo(
    () => visibleGroups.flatMap(g => g.items.map(i => ({ ...i, group: g.label }))),
    [visibleGroups]
  );

  // Collapsible group expansion — persisted across reloads; by default only
  // the group containing the active page is expanded.
  const activeGroupId = visibleGroups.find(g => g.items.some(i => i.path === location))?.id;
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>(() => {
    try {
      const saved = localStorage.getItem(NAV_EXPANDED_KEY);
      if (saved) return JSON.parse(saved) as Record<string, boolean>;
    } catch { /* ignore corrupt state */ }
    return {};
  });

  useEffect(() => {
    localStorage.setItem(NAV_EXPANDED_KEY, JSON.stringify(expandedGroups));
  }, [expandedGroups]);

  // Auto-expand the group containing the active page unless the user has
  // explicitly collapsed it before.
  useEffect(() => {
    if (activeGroupId && expandedGroups[activeGroupId] === undefined) {
      setExpandedGroups(prev => ({ ...prev, [activeGroupId]: true }));
    }
  }, [activeGroupId]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleGroup = (id: string, open: boolean) =>
    setExpandedGroups(prev => ({ ...prev, [id]: open }));

  // Current page label
  const activeItem = allItems.find(i => i.path === location);

  // Search results
  const searchResults = useMemo(() => {
    if (!searchQuery) return [];
    return allItems.filter(i =>
      i.label.toLowerCase().includes(searchQuery.toLowerCase()) ||
      i.group.toLowerCase().includes(searchQuery.toLowerCase())
    ).slice(0, 8);
  }, [searchQuery, allItems]);

  // Focus search input when opened
  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);

  // Keyboard shortcut: Cmd+K to focus search
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setSearchOpen(true);
      }
      if (e.key === "Escape") {
        setSearchOpen(false);
        setSearchQuery("");
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const handleNavigate = (path: string) => {
    setLocation(path);
    setSearchQuery("");
    setSearchOpen(false);
  };

  useEffect(() => {
    if (isCollapsed) setIsResizing(false);
  }, [isCollapsed]);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing) return;
      const sidebarLeft = sidebarRef.current?.getBoundingClientRect().left ?? 0;
      const newWidth = e.clientX - sidebarLeft;
      if (newWidth >= MIN_WIDTH && newWidth <= MAX_WIDTH) {
        setSidebarWidth(newWidth);
      }
    };

    const handleMouseUp = () => setIsResizing(false);

    if (isResizing) {
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    }

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [isResizing, setSidebarWidth]);

  return (
    <>
      <div ref={sidebarRef} className="relative">
        <Sidebar collapsible="icon" className="border-r-0">
          <SidebarHeader className="border-b">
            <div className="flex items-center gap-2 px-2 py-1">
              {!isCollapsed && (
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  {!IS_PLATFORM_ADMIN && myTenant?.logoUrl ? (
                    <img
                      src={myTenant.logoUrl}
                      alt={myTenant.name ?? "Tenant logo"}
                      className="w-7 h-7 rounded-lg object-contain shrink-0 bg-white/10"
                    />
                  ) : (
                    <div
                      className="w-7 h-7 rounded-lg bg-primary flex items-center justify-center shrink-0"
                      style={!IS_PLATFORM_ADMIN && myTenant?.primaryColor ? { backgroundColor: myTenant.primaryColor } : undefined}
                    >
                      {IS_PLATFORM_ADMIN
                        ? <Shield className="h-4 w-4 text-primary-foreground" />
                        : <ShoppingBag className="h-4 w-4 text-primary-foreground" />}
                    </div>
                  )}
                  <span className="font-bold text-sm truncate">
                    {IS_PLATFORM_ADMIN ? "Platform Admin" : (myTenant?.name ?? "WhatsApp Commerce")}
                  </span>
                </div>
              )}
              <button
                onClick={() => setSearchOpen(v => !v)}
                className="p-1.5 rounded-md hover:bg-accent transition-colors ml-auto"
                title="Search navigation (⌘K)"
              >
                <Search className="h-4 w-4 text-muted-foreground" />
              </button>
            </div>

            {/* Nav search */}
            {searchOpen && !isCollapsed && (
              <div className="px-2 pb-2 relative">
                <input
                  ref={searchInputRef}
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  placeholder="Search pages…"
                  className="w-full h-8 rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-primary"
                />
                {searchResults.length > 0 && (
                  <div className="absolute left-2 right-2 top-full z-50 mt-1 rounded-md border bg-popover shadow-lg overflow-hidden">
                    {searchResults.map(item => (
                      <button
                        key={item.path}
                        onClick={() => handleNavigate(item.path)}
                        className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent text-left"
                      >
                        <item.icon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                        <span>{item.label}</span>
                        <span className="ml-auto text-xs text-muted-foreground">{item.group}</span>
                      </button>
                    ))}
                  </div>
                )}
                {searchQuery && searchResults.length === 0 && (
                  <div className="absolute left-2 right-2 top-full z-50 mt-1 rounded-md border bg-popover shadow-lg px-3 py-2 text-sm text-muted-foreground">
                    No results
                  </div>
                )}
              </div>
            )}
          </SidebarHeader>

          <SidebarContent className="gap-0 px-2 py-2">
            {visibleGroups.map(group => (
                <NavGroup
                  key={group.id}
                  group={group}
                  location={location}
                  setLocation={handleNavigate}
                  isCollapsed={isCollapsed}
                  searchQuery={searchQuery}
                  open={expandedGroups[group.id] ?? false}
                  onOpenChange={(open) => toggleGroup(group.id, open)}
                />
              ))}
          </SidebarContent>

          <SidebarFooter>
            <SidebarMenu>
              <SidebarMenuItem>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <SidebarMenuButton className="h-12">
                      <Avatar className="h-8 w-8">
                        <AvatarFallback className="text-xs">
                          {user?.name?.charAt(0)?.toUpperCase() ?? "U"}
                        </AvatarFallback>
                      </Avatar>
                      {!isCollapsed && (
                        <div className="flex flex-col text-left min-w-0">
                          <span className="text-sm font-medium truncate">{user?.name ?? "User"}</span>
                          <span className="text-xs text-muted-foreground truncate">{user?.email ?? ""}</span>
                        </div>
                      )}
                    </SidebarMenuButton>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent side="top" align="start" className="w-56">
                    <DropdownMenuItem onClick={() => setLocation("/settings")}>
                      <Settings className="mr-2 h-4 w-4" /> Settings
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={logout}>
                      <LogOut className="mr-2 h-4 w-4" /> Sign out
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarFooter>
        </Sidebar>

        {/* Resize handle */}
        <div
          className={`absolute top-0 right-0 w-1 h-full cursor-col-resize hover:bg-primary/20 transition-colors ${isCollapsed ? "hidden" : ""}`}
          onMouseDown={() => setIsResizing(true)}
          style={{ zIndex: 50 }}
        />
      </div>

      <SidebarInset>
        {/* Top bar */}
        <div className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger />
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span>{allItems.find(i => i.path === location)?.group ?? ""}</span>
            <ChevronRight className="h-3 w-3" />
            <span className="text-foreground font-medium">{activeItem?.label ?? "Dashboard"}</span>
          </div>
          <div className="ml-auto">
            <NotificationCenter />
          </div>
        </div>
        <main className="flex-1 overflow-auto">{children}</main>
      </SidebarInset>
    </>
  );
}
