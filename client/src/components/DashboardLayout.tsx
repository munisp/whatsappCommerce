import { useAuth } from "@/_core/hooks/useAuth";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
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
import { startLogin } from "@/const";
import { useIsMobile } from "@/hooks/useMobile";
import { Activity, AlertTriangle, BarChart3, Bell, Bot, BrainCircuit, Building2, ChevronDown, CreditCard, FileText, GitBranch, GitMerge, Globe, LayoutDashboard, Link2, LogOut, Megaphone, MessageSquare, MessagesSquare, Network, Package, PanelLeft, Rocket, Server, Settings, Smartphone, UserPlus, Users, Warehouse } from "lucide-react";
import { CSSProperties, useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { DashboardLayoutSkeleton } from './DashboardLayoutSkeleton';
import { Button } from "./ui/button";
import { trpc } from "@/lib/trpc";
import { useActiveTenant } from "@/contexts/TenantContext";

type NavItem = { icon: React.ElementType; label: string; path: string; section?: string };
const menuItems: NavItem[] = [
  // ── Platform ──────────────────────────────────────────────────────────────
  { icon: LayoutDashboard, label: "Dashboard",      path: "/dashboard",    section: "Platform" },
  { icon: Building2,       label: "Tenants",        path: "/tenants",      section: "Platform" },
  { icon: Package,         label: "Products",       path: "/products",     section: "Platform" },
  { icon: MessageSquare,   label: "Conversations",  path: "/conversations",section: "Platform" },
  { icon: BarChart3,       label: "Orders",         path: "/orders",       section: "Platform" },
  { icon: CreditCard,      label: "Payments",       path: "/payments",     section: "Platform" },
  // ── Integrations ──────────────────────────────────────────────────────────
  { icon: Globe,           label: "Integration Hub",path: "/integrations", section: "Integrations" },
  { icon: Users,           label: "Twenty CRM",     path: "/twenty-crm",   section: "Integrations" },
  { icon: Package,         label: "Odoo ERP",       path: "/odoo-erp",     section: "Integrations" },
  { icon: Smartphone,      label: "Menu Builder",   path: "/menu-builder", section: "Integrations" },
  { icon: MessageSquare,   label: "Templates",      path: "/templates",    section: "Integrations" },
  { icon: Link2,           label: "Menu Assignment",path: "/tenant-menus", section: "Integrations" },
  { icon: GitBranch,       label: "Version Control",path: "/template-versions", section: "Integrations" },
  { icon: Megaphone,       label: "Broadcasts",     path: "/broadcast",    section: "Integrations" },
  { icon: Warehouse,       label: "Inventory Sync", path: "/inventory",    section: "Integrations" },
  { icon: FileText,        label: "Invoices",        path: "/invoices",     section: "Integrations" },
  // ── System ────────────────────────────────────────────────────────────────
  { icon: Bot,             label: "AI Agent",       path: "/agent",        section: "System" },
  { icon: Network,         label: "AI Architecture",path: "/agent-architecture", section: "System" },
  { icon: UserPlus,        label: "Onboard Tenant", path: "/onboarding",   section: "System" },
  { icon: MessagesSquare,  label: "NLP Simulator",  path: "/nlp-simulator",section: "System" },
  { icon: Server,          label: "Service Health", path: "/health",       section: "System" },
  { icon: Settings,        label: "Setup Wizard",   path: "/setup",        section: "System" },
  { icon: Building2,       label: "Merchant Portal",path: "/portal",       section: "System" },
  { icon: Rocket,          label: "Deploy Checklist",path: "/deploy-checklist", section: "System" },
  { icon: BrainCircuit,    label: "ML Ops",          path: "/ml-ops",           section: "System" },
  { icon: GitMerge,        label: "Reconciliation",  path: "/reconciliation",   section: "System" },
  { icon: Bell,            label: "Alert Rules",     path: "/alert-rules",      section: "System" },
];

const SIDEBAR_WIDTH_KEY = "sidebar-width";
const DEFAULT_WIDTH = 280;
const MIN_WIDTH = 200;
const MAX_WIDTH = 480;

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = localStorage.getItem(SIDEBAR_WIDTH_KEY);
    return saved ? parseInt(saved, 10) : DEFAULT_WIDTH;
  });
  const { loading, user } = useAuth();

  useEffect(() => {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, sidebarWidth.toString());
  }, [sidebarWidth]);

  if (loading) {
    return <DashboardLayoutSkeleton />
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
              Access to this dashboard requires authentication. Continue to launch the login flow.
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
    <SidebarProvider
      style={
        {
          "--sidebar-width": `${sidebarWidth}px`,
        } as CSSProperties
      }
    >
      <DashboardLayoutContent setSidebarWidth={setSidebarWidth}>
        {children}
      </DashboardLayoutContent>
    </SidebarProvider>
  );
}

type DashboardLayoutContentProps = {
  children: React.ReactNode;
  setSidebarWidth: (width: number) => void;
};

function DashboardLayoutContent({
  children,
  setSidebarWidth,
}: DashboardLayoutContentProps) {
  const { user, logout } = useAuth();
  const [location, setLocation] = useLocation();
  const { state, toggleSidebar } = useSidebar();
  const isCollapsed = state === "collapsed";
  const [isResizing, setIsResizing] = useState(false);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const activeMenuItem = menuItems.find(item => item.path === location);
  const isMobile = useIsMobile();
  const { activeTenantId, setActiveTenantId } = useActiveTenant();
  const { data: tenantList } = trpc.tenant.list.useQuery({ limit: 20 });
  const activeTenant = tenantList?.find((t: { id: string }) => t.id === activeTenantId);

  useEffect(() => {
    if (isCollapsed) {
      setIsResizing(false);
    }
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

    const handleMouseUp = () => {
      setIsResizing(false);
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
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [isResizing, setSidebarWidth]);

  return (
    <>
      <div className="relative" ref={sidebarRef}>
        <Sidebar
          collapsible="icon"
          className="border-r-0"
          disableTransition={isResizing}
        >
          <SidebarHeader className="h-16 justify-center">
            <div className="flex items-center gap-3 px-2 transition-all w-full">
              <button
                onClick={toggleSidebar}
                className="h-8 w-8 flex items-center justify-center hover:bg-accent rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring shrink-0"
                aria-label="Toggle navigation"
              >
                <PanelLeft className="h-4 w-4 text-muted-foreground" />
              </button>
              {!isCollapsed ? (
                <div className="flex items-center gap-2 min-w-0">
                  <span className="font-semibold tracking-tight truncate text-sm">WhatsApp Commerce</span>
                </div>
              ) : null}
            </div>
            {!isCollapsed && (
              <div className="px-3 pb-2">
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
          </SidebarHeader>

          <SidebarContent className="gap-0">
            <SidebarMenu className="px-2 py-1">
              {(() => {
                const sections = Array.from(new Set(menuItems.map(i => i.section ?? ""))).filter(Boolean);
                return sections.map((section, si) => (
                  <div key={section}>
                    {!isCollapsed && (
                      <div className={`px-3 py-1 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/50 ${si > 0 ? "mt-2 pt-2 border-t border-border" : ""}`}>
                        {section}
                      </div>
                    )}
                    {menuItems.filter(i => (i.section ?? "") === section).map(item => {
                      const isActive = location === item.path;
                      return (
                        <SidebarMenuItem key={item.path}>
                          <SidebarMenuButton
                            isActive={isActive}
                            onClick={() => setLocation(item.path)}
                            tooltip={item.label}
                            className="h-10 transition-all font-normal"
                          >
                            <item.icon className={`h-4 w-4 ${isActive ? "text-primary" : ""}`} />
                            <span>{item.label}</span>
                          </SidebarMenuButton>
                        </SidebarMenuItem>
                      );
                    })}
                  </div>
                ));
              })()}
            </SidebarMenu>
          </SidebarContent>

          <SidebarFooter className="p-3">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="flex items-center gap-3 rounded-lg px-1 py-1 hover:bg-accent/50 transition-colors w-full text-left group-data-[collapsible=icon]:justify-center focus:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  <Avatar className="h-9 w-9 border shrink-0">
                    <AvatarFallback className="text-xs font-medium">
                      {user?.name?.charAt(0).toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                  <div className="flex-1 min-w-0 group-data-[collapsible=icon]:hidden">
                    <p className="text-sm font-medium truncate leading-none">
                      {user?.name || "-"}
                    </p>
                    <p className="text-xs text-muted-foreground truncate mt-1.5">
                      {user?.email || "-"}
                    </p>
                  </div>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuItem
                  onClick={logout}
                  className="cursor-pointer text-destructive focus:text-destructive"
                >
                  <LogOut className="mr-2 h-4 w-4" />
                  <span>Sign out</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarFooter>
        </Sidebar>
        <div
          className={`absolute top-0 right-0 w-1 h-full cursor-col-resize hover:bg-primary/20 transition-colors ${isCollapsed ? "hidden" : ""}`}
          onMouseDown={() => {
            if (isCollapsed) return;
            setIsResizing(true);
          }}
          style={{ zIndex: 50 }}
        />
      </div>

      <SidebarInset>
        {isMobile && (
          <div className="flex border-b h-14 items-center justify-between bg-background/95 px-2 backdrop-blur supports-[backdrop-filter]:backdrop-blur sticky top-0 z-40">
            <div className="flex items-center gap-2">
              <SidebarTrigger className="h-9 w-9 rounded-lg bg-background" />
              <div className="flex items-center gap-3">
                <div className="flex flex-col gap-1">
                  <span className="tracking-tight text-foreground">
                    {activeMenuItem?.label ?? "Menu"}
                  </span>
                </div>
              </div>
            </div>
          </div>
        )}
        <main className="flex-1 p-4">{children}</main>
      </SidebarInset>
    </>
  );
}
