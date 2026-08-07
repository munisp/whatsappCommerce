import { useAuth } from "@/_core/hooks/useAuth";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
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
import { startLogin, startLogout } from "@/const";
import { useIsMobile } from "@/hooks/useMobile";
import {
  Activity, AlertTriangle, ArrowLeftRight, BarChart3, Bell, Bot, BrainCircuit,
  Building2, Calendar, ChevronDown, ChevronRight, CreditCard, Database, Eye,
  FileCode, FileText, GitBranch, GitMerge, Globe, ImagePlus, LayoutDashboard,
  Leaf, Link2, Lock, LogOut, Megaphone, MessageSquare, MessagesSquare, Network,
  Package, Paperclip, PanelLeft, Rocket, ScrollText, Search, Server, Settings,
  Shield, ShoppingBag, Smartphone, Store, TrendingUp, Truck, UserPlus, Users,
  Warehouse, BarChart2, Zap, KeyRound, User, ExternalLink, Layers, Cpu, Workflow,
} from "lucide-react";
import { CSSProperties, useEffect, useRef, useState, useMemo } from "react";
import { useLocation } from "wouter";
import { DashboardLayoutSkeleton } from "./DashboardLayoutSkeleton";
import { Button } from "./ui/button";
import { trpc } from "@/lib/trpc";
import { useActiveTenant } from "@/contexts/TenantContext";

// ── Navigation structure ───────────────────────────────────────────────────────

type NavItem = {
  icon: React.ElementType;
  label: string;
  path: string;
  badge?: string;
  external?: boolean;
};

type NavGroup = {
  id: string;
  label: string;
  icon: React.ElementType;
  items: NavItem[];
  defaultOpen?: boolean;
};

const NAV_GROUPS: NavGroup[] = [
  {
    id: "platform",
    label: "Platform",
    icon: LayoutDashboard,
    defaultOpen: true,
    items: [
      { icon: LayoutDashboard, label: "Dashboard",       path: "/dashboard" },
      { icon: Building2,       label: "Tenants",         path: "/tenants" },
      { icon: Package,         label: "Products",        path: "/products" },
      { icon: MessageSquare,   label: "Conversations",   path: "/conversations" },
      { icon: BarChart3,       label: "Orders",          path: "/orders" },
      { icon: CreditCard,      label: "Payments",        path: "/payments" },
      { icon: FileCode,        label: "Msg Templates",   path: "/operator-templates" },
    ],
  },
  {
    id: "messaging",
    label: "Messaging & Channels",
    icon: MessagesSquare,
    items: [
      { icon: Megaphone,       label: "Broadcasts",      path: "/broadcast" },
      { icon: MessageSquare,   label: "WA Templates",    path: "/templates" },
      { icon: GitBranch,       label: "Template Versions", path: "/template-versions" },
      { icon: Smartphone,      label: "Menu Builder",    path: "/menu-builder" },
      { icon: Link2,           label: "Menu Assignment", path: "/tenant-menus" },
      { icon: Globe,           label: "Multi-Channel",   path: "/multi-channel" },
      { icon: Paperclip,       label: "WA Media",        path: "/whatsapp-media" },
      { icon: MessageSquare,   label: "WA Profile",      path: "/whatsapp-profile" },
    ],
  },
  {
    id: "commerce",
    label: "Commerce",
    icon: ShoppingBag,
    items: [
      { icon: Store,           label: "Marketplace",     path: "/marketplace" },
      { icon: Building2,       label: "B2B Portal",      path: "/b2b" },
      { icon: Smartphone,      label: "Mobile Money",    path: "/mobile-money" },
      { icon: Calendar,        label: "Service Commerce", path: "/service-commerce" },
      { icon: FileText,        label: "Invoices",        path: "/invoices" },
      { icon: Package,         label: "Medusa Commerce", path: "/medusa" },
      { icon: ShoppingBag,     label: "Medusa Onboarding", path: "/medusa-onboarding" },
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
      { icon: ArrowLeftRight,  label: "Odoo↔Medusa",     path: "/odoo-medusa-bridge" },
      { icon: Warehouse,       label: "Inventory Sync",  path: "/inventory" },
    ],
  },
  {
    id: "finance",
    label: "Finance & Payments",
    icon: CreditCard,
    items: [
      { icon: Lock,            label: "Escrow",          path: "/escrow" },
      { icon: Truck,           label: "Logistics",       path: "/logistics" },
      { icon: AlertTriangle,   label: "Disputes",        path: "/disputes" },
      { icon: GitMerge,        label: "Reconciliation",  path: "/reconciliation" },
      { icon: TrendingUp,      label: "Revenue",         path: "/revenue" },
      { icon: AlertTriangle,   label: "COGS Disputes",   path: "/cogs-disputes" },
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
      { icon: Zap,             label: "Hermes Agent",    path: "/hermes" },
      { icon: Cpu,             label: "Infra Health",    path: "/infra-health" },
    ],
  },
  {
    id: "inventory",
    label: "Inventory & Catalog",
    icon: Warehouse,
    items: [
      { icon: Eye,             label: "Visual Inventory", path: "/visual-inventory" },
      { icon: Leaf,            label: "FMCG Taxonomy",   path: "/fmcg-taxonomy" },
      { icon: Database,        label: "Label Studio",    path: "/label-studio" },
      { icon: BarChart2,       label: "Scan Accuracy",   path: "/scan-stats" },
      { icon: ImagePlus,       label: "Product Images",  path: "/product-images" },
    ],
  },
  {
    id: "analytics",
    label: "Analytics & Reports",
    icon: BarChart3,
    items: [
      { icon: BarChart3,       label: "Analytics BI",    path: "/analytics-bi" },
      { icon: BarChart2,       label: "Tenant Analytics", path: "/tenant-analytics" },
      { icon: Activity,        label: "Service Health",  path: "/health" },
      { icon: Workflow,        label: "Temporal Workflows", path: "/infra-health" },
    ],
  },
  {
    id: "admin",
    label: "Administration",
    icon: Settings,
    items: [
      { icon: UserPlus,        label: "Onboard Tenant",  path: "/onboarding" },
      { icon: Settings,        label: "Setup Wizard",    path: "/setup" },
      { icon: Building2,       label: "Merchant Portal", path: "/portal" },
      { icon: Bell,            label: "Alert Rules",     path: "/alert-rules" },
      { icon: Shield,          label: "SSO Users",       path: "/sso-users" },
      { icon: KeyRound,        label: "Phone Auth",      path: "/phone-auth" },
      { icon: ScrollText,      label: "Audit Log",       path: "/audit-log" },
      { icon: AlertTriangle,   label: "Webhook DLQ",     path: "/webhook-dlq" },
      { icon: Shield,          label: "Compliance/B2G",  path: "/compliance" },
      { icon: Rocket,          label: "Deploy Checklist", path: "/deploy-checklist" },
    ],
  },
];

// Flatten all items for search
const ALL_ITEMS = NAV_GROUPS.flatMap(g => g.items.map(i => ({ ...i, group: g.label })));

// ── Sidebar width ──────────────────────────────────────────────────────────────

const SIDEBAR_WIDTH_KEY = "sidebar-width";
const DEFAULT_WIDTH = 260;
const MIN_WIDTH = 200;
const MAX_WIDTH = 400;

// ── Main component ─────────────────────────────────────────────────────────────

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = localStorage.getItem(SIDEBAR_WIDTH_KEY);
    return saved ? parseInt(saved, 10) : DEFAULT_WIDTH;
  });
  const { loading, user } = useAuth();

  useEffect(() => {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, sidebarWidth.toString());
  }, [sidebarWidth]);

  if (loading) return <DashboardLayoutSkeleton />;

  if (!user) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-background">
        <div className="flex flex-col items-center gap-8 p-8 max-w-md w-full">
          <div className="flex flex-col items-center gap-4">
            <div className="h-12 w-12 rounded-xl bg-primary/10 flex items-center justify-center">
              <MessageSquare className="h-6 w-6 text-primary" />
            </div>
            <h1 className="text-2xl font-semibold tracking-tight text-center">
              WhatsApp Commerce Platform
            </h1>
            <p className="text-sm text-muted-foreground text-center max-w-sm">
              Sign in with your administrator credentials to access the platform dashboard.
            </p>
          </div>
          <Button onClick={() => startLogin()} size="lg" className="w-full">
            Sign in with Keycloak
          </Button>
        </div>
      </div>
    );
  }

  return (
    <SidebarProvider style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}>
      <DashboardLayoutContent setSidebarWidth={setSidebarWidth}>
        {children}
      </DashboardLayoutContent>
    </SidebarProvider>
  );
}

// ── Nav group component ────────────────────────────────────────────────────────

function NavGroup({
  group,
  location,
  setLocation,
  isCollapsed,
  searchQuery,
}: {
  group: NavGroup;
  location: string;
  setLocation: (path: string) => void;
  isCollapsed: boolean;
  searchQuery: string;
}) {
  const [open, setOpen] = useState(group.defaultOpen ?? false);
  const Icon = group.icon;

  const filteredItems = searchQuery
    ? group.items.filter(i => i.label.toLowerCase().includes(searchQuery.toLowerCase()))
    : group.items;

  const hasActiveItem = group.items.some(i => i.path === location);

  // Auto-open group if it has the active item or search matches
  useEffect(() => {
    if (hasActiveItem || (searchQuery && filteredItems.length > 0)) {
      setOpen(true);
    }
  }, [hasActiveItem, searchQuery, filteredItems.length]);

  if (searchQuery && filteredItems.length === 0) return null;

  if (isCollapsed) {
    return (
      <div className="mb-1">
        {filteredItems.map(item => {
          const ItemIcon = item.icon;
          const isActive = location === item.path;
          return (
            <SidebarMenuItem key={item.path}>
              <SidebarMenuButton
                isActive={isActive}
                onClick={() => setLocation(item.path)}
                tooltip={item.label}
                className="h-9"
              >
                <ItemIcon className={`h-4 w-4 ${isActive ? "text-primary" : ""}`} />
              </SidebarMenuButton>
            </SidebarMenuItem>
          );
        })}
      </div>
    );
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="mb-1">
      <CollapsibleTrigger asChild>
        <button className={`flex items-center justify-between w-full px-3 py-1.5 text-xs font-semibold uppercase tracking-widest rounded-md transition-colors
          ${hasActiveItem ? "text-primary" : "text-muted-foreground/60 hover:text-muted-foreground"}`}>
          <div className="flex items-center gap-1.5">
            <Icon className="h-3 w-3" />
            <span>{group.label}</span>
          </div>
          {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="ml-2 border-l border-border/40 pl-2 mb-1">
          {filteredItems.map(item => {
            const ItemIcon = item.icon;
            const isActive = location === item.path;
            return (
              <SidebarMenuItem key={item.path}>
                <SidebarMenuButton
                  isActive={isActive}
                  onClick={() => setLocation(item.path)}
                  tooltip={item.label}
                  className="h-8 text-sm font-normal"
                >
                  <ItemIcon className={`h-3.5 w-3.5 shrink-0 ${isActive ? "text-primary" : ""}`} />
                  <span className="truncate">{item.label}</span>
                  {item.badge && (
                    <Badge variant="secondary" className="ml-auto text-[10px] h-4 px-1">
                      {item.badge}
                    </Badge>
                  )}
                </SidebarMenuButton>
              </SidebarMenuItem>
            );
          })}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

// ── Layout content ─────────────────────────────────────────────────────────────

function DashboardLayoutContent({
  children,
  setSidebarWidth,
}: {
  children: React.ReactNode;
  setSidebarWidth: (w: number) => void;
}) {
  const { user, logout } = useAuth();
  const [location, setLocation] = useLocation();
  const { state, toggleSidebar } = useSidebar();
  const isCollapsed = state === "collapsed";
  const [isResizing, setIsResizing] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const sidebarRef = useRef<HTMLDivElement>(null);
  const isMobile = useIsMobile();
  const { activeTenantId, setActiveTenantId } = useActiveTenant();
  const { data: tenantList } = trpc.tenant.list.useQuery({ limit: 20 });
  const activeTenant = tenantList?.find((t: { id: string }) => t.id === activeTenantId);

  // Current page label
  const activeItem = ALL_ITEMS.find(i => i.path === location);

  // Search results
  const searchResults = useMemo(() => {
    if (!searchQuery) return [];
    return ALL_ITEMS.filter(i =>
      i.label.toLowerCase().includes(searchQuery.toLowerCase()) ||
      i.group.toLowerCase().includes(searchQuery.toLowerCase())
    ).slice(0, 8);
  }, [searchQuery]);

  // Resize handler
  useEffect(() => {
    if (isCollapsed) { setIsResizing(false); return; }
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing) return;
      const sidebarLeft = sidebarRef.current?.getBoundingClientRect().left ?? 0;
      const newWidth = e.clientX - sidebarLeft;
      if (newWidth >= MIN_WIDTH && newWidth <= MAX_WIDTH) setSidebarWidth(newWidth);
    };
    const handleMouseUp = () => {
      setIsResizing(false);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    if (isResizing) {
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    }
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isResizing, setSidebarWidth, isCollapsed]);

  const handleNavigate = (path: string) => {
    setLocation(path);
    setSearchQuery("");
  };

  return (
    <>
      <div className="relative" ref={sidebarRef}>
        <Sidebar collapsible="icon" className="border-r-0" disableTransition={isResizing}>
          {/* Header */}
          <SidebarHeader className="pb-0">
            <div className="flex items-center gap-2 px-2 h-12">
              <button
                onClick={toggleSidebar}
                className="h-8 w-8 flex items-center justify-center hover:bg-accent rounded-lg transition-colors shrink-0"
                aria-label="Toggle navigation"
              >
                <PanelLeft className="h-4 w-4 text-muted-foreground" />
              </button>
              {!isCollapsed && (
                <span className="font-semibold text-sm truncate">WhatsApp Commerce</span>
              )}
            </div>

            {/* Tenant selector */}
            {!isCollapsed && (
              <div className="px-2 pb-2">
                <Select value={activeTenantId} onValueChange={setActiveTenantId}>
                  <SelectTrigger className="h-8 text-xs bg-muted/40 border-border/50 w-full">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <Building2 className="h-3 w-3 text-primary shrink-0" />
                      <SelectValue placeholder="Select tenant">
                        <span className="truncate">{activeTenant?.name ?? activeTenantId}</span>
                      </SelectValue>
                    </div>
                  </SelectTrigger>
                  <SelectContent>
                    {tenantList?.map((t: { id: string; name: string | null; slug: string }) => (
                      <SelectItem key={t.id} value={t.id} className="text-xs">
                        <span className="font-medium">{t.name ?? t.slug}</span>
                        <span className="ml-1.5 text-muted-foreground">{t.slug}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {/* Search */}
            {!isCollapsed && (
              <div className="px-2 pb-2 relative">
                <div className="relative">
                  <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
                  <Input
                    placeholder="Search pages..."
                    value={searchQuery}
                    onChange={e => setSearchQuery(e.target.value)}
                    className="h-7 pl-7 text-xs bg-muted/40 border-border/50"
                  />
                </div>
                {searchQuery && searchResults.length > 0 && (
                  <div className="absolute left-2 right-2 top-full mt-1 bg-popover border border-border rounded-md shadow-lg z-50 overflow-hidden">
                    {searchResults.map(item => {
                      const ItemIcon = item.icon;
                      return (
                        <button
                          key={item.path}
                          onClick={() => handleNavigate(item.path)}
                          className="flex items-center gap-2 w-full px-3 py-2 text-xs hover:bg-accent transition-colors text-left"
                        >
                          <ItemIcon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                          <span className="font-medium">{item.label}</span>
                          <span className="text-muted-foreground ml-auto">{item.group}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </SidebarHeader>

          {/* Nav groups */}
          <SidebarContent className="gap-0 overflow-y-auto">
            <SidebarMenu className="px-2 py-1">
              {NAV_GROUPS.map(group => (
                <NavGroup
                  key={group.id}
                  group={group}
                  location={location}
                  setLocation={handleNavigate}
                  isCollapsed={isCollapsed}
                  searchQuery={searchQuery}
                />
              ))}
            </SidebarMenu>
          </SidebarContent>

          {/* Footer */}
          <SidebarFooter className="p-2 border-t border-border/50">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="flex items-center gap-2 rounded-lg px-2 py-2 hover:bg-accent/50 transition-colors w-full text-left focus:outline-none">
                  <Avatar className="h-8 w-8 border shrink-0">
                    <AvatarFallback className="text-xs font-medium bg-primary/10 text-primary">
                      {user?.name?.charAt(0).toUpperCase() ?? "A"}
                    </AvatarFallback>
                  </Avatar>
                  {!isCollapsed && (
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium truncate leading-none">{user?.name || "-"}</p>
                      <p className="text-[10px] text-muted-foreground truncate mt-0.5">{user?.email || "-"}</p>
                    </div>
                  )}
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <div className="px-2 py-1.5">
                  <p className="text-xs font-medium">{user?.name}</p>
                  <p className="text-xs text-muted-foreground">{user?.email}</p>
                  <Badge variant="outline" className="mt-1 text-[10px] h-4 px-1">{user?.role ?? "admin"}</Badge>
                </div>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => setLocation("/portal")} className="cursor-pointer text-xs">
                  <User className="mr-2 h-3.5 w-3.5" />
                  Merchant Portal
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setLocation("/setup")} className="cursor-pointer text-xs">
                  <Settings className="mr-2 h-3.5 w-3.5" />
                  Settings
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setLocation("/infra-health")} className="cursor-pointer text-xs">
                  <Activity className="mr-2 h-3.5 w-3.5" />
                  Infrastructure Health
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => { logout(); startLogout(); }}
                  className="cursor-pointer text-destructive focus:text-destructive text-xs"
                >
                  <LogOut className="mr-2 h-3.5 w-3.5" />
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarFooter>
        </Sidebar>

        {/* Resize handle */}
        {!isCollapsed && (
          <div
            className="absolute top-0 right-0 w-1 h-full cursor-col-resize hover:bg-primary/20 transition-colors"
            onMouseDown={() => setIsResizing(true)}
            style={{ zIndex: 50 }}
          />
        )}
      </div>

      <SidebarInset>
        {/* Mobile header */}
        {isMobile && (
          <div className="flex border-b h-12 items-center justify-between bg-background/95 px-3 backdrop-blur sticky top-0 z-40">
            <div className="flex items-center gap-2">
              <SidebarTrigger className="h-8 w-8 rounded-lg" />
              <span className="text-sm font-medium">{activeItem?.label ?? "Menu"}</span>
            </div>
          </div>
        )}

        {/* Breadcrumb for desktop */}
        {!isMobile && activeItem && (
          <div className="flex items-center gap-1 px-4 pt-3 pb-0 text-xs text-muted-foreground">
            <span>{ALL_ITEMS.find(i => i.path === location)?.group ?? ""}</span>
            <ChevronRight className="h-3 w-3" />
            <span className="text-foreground font-medium">{activeItem.label}</span>
          </div>
        )}

        <main className="flex-1 p-4">{children}</main>
      </SidebarInset>
    </>
  );
}
