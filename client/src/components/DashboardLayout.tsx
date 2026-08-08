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
  LayoutDashboard, LogOut, PanelLeft, Package, MessageSquare, BarChart3,
  CreditCard, Settings, Users, ShoppingBag, Bell, FileText, Globe,
  Zap, TrendingUp, Shield, Store, Truck, ChevronRight, ChevronDown,
  Search, Bot, Megaphone, FileCode, ImagePlus, GitMerge, MessagesSquare,
  BrainCircuit, Warehouse, Smartphone, Link2, Eye, ArrowLeftRight,
  Database, GitBranch, AlertTriangle, Activity, Lock, Network,
  UserPlus, Rocket, KeyRound, Building2, ScrollText, Workflow, Leaf,
  Calendar, Paperclip, BarChart2, Cpu, ListTree, Plug, SlidersHorizontal, Map, HeartPulse,
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
  adminOnly?: boolean;
};

const NAV_GROUPS: NavGroup[] = [
  {
    id: "overview",
    label: "Overview",
    icon: LayoutDashboard,
    items: [
      { icon: LayoutDashboard, label: "Dashboard",       path: "/dashboard" },
    ],
  },
  {
    id: "commerce",
    label: "Commerce & Catalog",
    icon: ShoppingBag,
    items: [
      { icon: Package,         label: "Products",        path: "/products" },
      { icon: Smartphone,      label: "Menu Builder",    path: "/menu-builder" },
      { icon: Link2,           label: "Menu Assignment", path: "/tenant-menus" },
      { icon: Warehouse,       label: "Inventory Sync",  path: "/inventory" },
      { icon: ImagePlus,       label: "Product Images",  path: "/product-images" },
      { icon: Eye,             label: "Visual Inventory", path: "/visual-inventory" },
      { icon: Leaf,            label: "FMCG Taxonomy",   path: "/fmcg-taxonomy" },
      { icon: Store,           label: "Marketplace",     path: "/marketplace" },
      { icon: Building2,       label: "B2B Portal",      path: "/b2b" },
      { icon: Calendar,        label: "Service Commerce", path: "/service-commerce" },
      { icon: Package,         label: "Medusa Commerce", path: "/medusa" },
      { icon: ShoppingBag,     label: "Medusa Onboarding", path: "/medusa-onboarding" },
      { icon: ArrowLeftRight,  label: "Odoo↔Medusa Bridge", path: "/odoo-medusa-bridge" },
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
    ],
  },
  {
    id: "orders",
    label: "Orders & Fulfilment",
    icon: Truck,
    items: [
      { icon: BarChart3,       label: "Orders",          path: "/orders" },
      { icon: Truck,           label: "Logistics",       path: "/logistics" },
      { icon: AlertTriangle,   label: "Disputes",        path: "/disputes" },
      { icon: AlertTriangle,   label: "COGS Disputes",   path: "/cogs-disputes" },
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
      { icon: GitMerge,        label: "Reconciliation",  path: "/reconciliation" },
      { icon: AlertTriangle,   label: "Webhook DLQ",     path: "/webhook-dlq" },
    ],
  },
  {
    id: "ai",
    label: "AI & ML",
    icon: BrainCircuit,
    items: [
      { icon: Bot,             label: "AI Agent",        path: "/agent" },
      { icon: Network,         label: "AI Architecture", path: "/agent-architecture" },
      { icon: MessagesSquare,  label: "NLP Simulator",   path: "/nlp-simulator" },
      { icon: BrainCircuit,    label: "ML Ops",          path: "/ml-ops" },
      { icon: ScrollText,      label: "Audit Log",       path: "/audit-log" },
      { icon: Database,        label: "Label Studio",    path: "/label-studio" },
      { icon: BarChart2,       label: "Scan Accuracy",   path: "/scan-stats" },
      { icon: Zap,             label: "Hermes Agent",    path: "/hermes" },
    ],
  },
  {
    id: "analytics",
    label: "Analytics",
    icon: BarChart3,
    items: [
      { icon: BarChart3,       label: "Analytics BI",    path: "/analytics-bi" },
      { icon: BarChart2,       label: "Tenant Analytics", path: "/tenant-analytics" },
    ],
  },
  {
    id: "integrations",
    label: "Integrations",
    icon: Globe,
    items: [
      { icon: Globe,           label: "Integration Hub", path: "/integrations" },
      { icon: Users,           label: "Twenty CRM",      path: "/twenty-crm" },
      { icon: Package,         label: "Odoo ERP",        path: "/odoo-erp" },
    ],
  },
  {
    id: "configuration",
    label: "Configuration",
    icon: SlidersHorizontal,
    items: [
      { icon: Smartphone,      label: "WA Menu Builder",  path: "/wa-menu-builder" },
      { icon: Rocket,          label: "Onboarding Wizard", path: "/onboarding-wizard" },
      { icon: Plug,            label: "Integration Settings", path: "/integration-settings" },
      { icon: SlidersHorizontal, label: "Tenant Settings", path: "/tenant-settings" },
    ],
  },
  {
    id: "ops",
    label: "Ops",
    icon: HeartPulse,
    items: [
      { icon: Map,             label: "Live Map",        path: "/logistics-map" },
      { icon: HeartPulse,      label: "System Health",   path: "/system-health" },
      { icon: ScrollText,      label: "Audit Logs",      path: "/audit-logs" },
    ],
  },
  {
    id: "admin",
    label: "Administration",
    icon: Settings,
    adminOnly: true,
    items: [
      { icon: Building2,       label: "Tenants",         path: "/tenants" },
      { icon: UserPlus,        label: "Onboard Tenant",  path: "/onboarding" },
      { icon: Building2,       label: "Merchant Portal", path: "/portal" },
      { icon: Shield,          label: "SSO Users",       path: "/sso-users" },
      { icon: KeyRound,        label: "Phone Auth",      path: "/phone-auth" },
      { icon: MessageSquare,   label: "WhatsApp Profile", path: "/whatsapp-profile" },
      { icon: Bell,            label: "Alert Rules",     path: "/alert-rules" },
      { icon: Activity,        label: "Service Health",  path: "/health" },
      { icon: Settings,        label: "Setup Wizard",    path: "/setup" },
      { icon: Rocket,          label: "Deploy Checklist", path: "/deploy-checklist" },
      { icon: Shield,          label: "Compliance/B2G",  path: "/compliance" },
      { icon: Cpu,             label: "Infra Health",    path: "/infra-health" },
    ],
  },
];

// Groups only visible to platform admins
function visibleGroupsForRole(role: string | undefined): NavGroup[] {
  return NAV_GROUPS.filter(g => !g.adminOnly || role === "admin");
}

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
  const { data: tenantList } = trpc.tenant.list.useQuery({ limit: 20 });
  // Tenant branding (public theme resolved from the request host): applied to
  // the shell header — name, logo and primary color.
  const { data: tenantTheme } = trpc.tenant.tenantTheme.useQuery();
  const activeTenant = tenantList?.find((t: { id: string }) => t.id === activeTenantId);

  // Role-filtered nav: Administration group is only visible to admins
  const visibleGroups = useMemo(() => visibleGroupsForRole(user?.role), [user?.role]);
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
                  {tenantTheme?.logoUrl ? (
                    <img
                      src={tenantTheme.logoUrl}
                      alt={tenantTheme.name}
                      className="w-7 h-7 rounded-lg object-contain shrink-0 bg-white/10"
                    />
                  ) : (
                    <div
                      className="w-7 h-7 rounded-lg bg-primary flex items-center justify-center shrink-0"
                      style={tenantTheme?.primaryColor ? { backgroundColor: tenantTheme.primaryColor } : undefined}
                    >
                      <ShoppingBag className="h-4 w-4 text-primary-foreground" />
                    </div>
                  )}
                  <span className="font-bold text-sm truncate">{tenantTheme?.name ?? "WhatsApp Commerce"}</span>
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

            {/* Tenant switcher */}
            {!isCollapsed && (
              <div className="px-2 pb-2">
                <select
                  value={activeTenantId}
                  onChange={e => setActiveTenantId(e.target.value)}
                  className="w-full h-8 rounded-md border bg-background px-2 text-sm outline-none focus:ring-2 focus:ring-primary"
                >
                  {!tenantList && <option value={activeTenantId}>{activeTenantId}</option>}
                  {tenantList?.map((t: { id: string; name: string }) => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
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
            {!isCollapsed && activeTenant && (
              <div className="px-3 py-2 border-t">
                <p className="text-xs text-muted-foreground truncate">Active tenant</p>
                <p className="text-sm font-medium truncate">{activeTenant.name}</p>
              </div>
            )}
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
