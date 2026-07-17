/**
 * WhatsAppProfilePage — WhatsApp Number Management & Notification Preferences
 *
 * Features:
 * - Linked WhatsApp number display with verification status badge
 * - Unlink action with confirmation dialog
 * - Notification preference toggles (orders, status updates, marketing)
 * - Re-verification flow if phone is linked but unverified
 */
import { useState } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import {
  MessageSquare,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Unlink,
  Bell,
  BellOff,
  ShoppingBag,
  Truck,
  Megaphone,
  Phone,
  ArrowRight,
} from "lucide-react";
import {
  Clock,
  Send,
  Eye,
  XCircle,
  Package,
  ChevronLeft,
  ChevronRight,
  History,
  Search,
  Filter,
  X,
} from "lucide-react";
import { Link } from "wouter";

// ── Linked Number Card ────────────────────────────────────────────────────────
function LinkedNumberCard() {
  const utils = trpc.useUtils();
  const { data: status, isLoading } = trpc.phoneAuth.getPhoneStatus.useQuery();

  const unlinkPhone = trpc.phoneAuth.unlinkPhone.useMutation({
    onSuccess: () => {
      utils.phoneAuth.getPhoneStatus.invalidate();
      toast.success("Phone number unlinked from your account.");
    },
    onError: (err) => toast.error(err.message),
  });

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-10">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  const hasPhone = !!status?.phone;
  const isVerified = status?.phoneVerified ?? false;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-lg bg-green-500/10 flex items-center justify-center">
            <MessageSquare className="h-5 w-5 text-green-600" />
          </div>
          <div>
            <CardTitle className="text-base">Linked WhatsApp Number</CardTitle>
            <CardDescription>Your verified phone number for WhatsApp notifications and OTP login</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {hasPhone ? (
          <>
            <div className="flex items-center justify-between p-4 rounded-lg bg-muted/40 border">
              <div className="flex items-center gap-3">
                <div className={`h-9 w-9 rounded-full flex items-center justify-center ${isVerified ? "bg-green-100" : "bg-yellow-100"}`}>
                  {isVerified ? (
                    <CheckCircle2 className="h-5 w-5 text-green-600" />
                  ) : (
                    <AlertCircle className="h-5 w-5 text-yellow-600" />
                  )}
                </div>
                <div>
                  <p className="font-mono font-medium text-sm">{status?.phone}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {isVerified ? "Verified and active" : "Linked but not yet verified"}
                  </p>
                </div>
              </div>
              <Badge
                variant={isVerified ? "secondary" : "outline"}
                className={isVerified ? "text-green-600 bg-green-50 border-green-200" : "text-yellow-600 border-yellow-300"}
              >
                {isVerified ? "Verified" : "Unverified"}
              </Badge>
            </div>

            {!isVerified && (
              <div className="flex items-center gap-2 p-3 rounded-lg bg-yellow-50 border border-yellow-200 text-sm">
                <AlertCircle className="h-4 w-4 text-yellow-600 shrink-0" />
                <span className="text-yellow-700">
                  Your number is linked but not verified. Notifications will not be sent until verified.
                </span>
                <Link href="/phone-auth" className="ml-auto shrink-0">
                  <Button size="sm" variant="outline" className="text-xs h-7 border-yellow-300 text-yellow-700 hover:bg-yellow-100">
                    Verify now <ArrowRight className="h-3 w-3 ml-1" />
                  </Button>
                </Link>
              </div>
            )}

            <Separator />

            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Remove linked number</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  You can re-link a number at any time from the Phone Auth page.
                </p>
              </div>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="outline" size="sm" className="text-destructive border-destructive/30 hover:bg-destructive/5">
                    <Unlink className="h-3.5 w-3.5 mr-1.5" />
                    Unlink
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Unlink phone number?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This will remove <span className="font-mono font-medium">{status?.phone}</span> from your account.
                      You will no longer receive WhatsApp notifications or be able to log in via phone OTP until you re-link a number.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={() => unlinkPhone.mutate()}
                      className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    >
                      {unlinkPhone.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Unlink number"}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </>
        ) : (
          <div className="flex flex-col items-center gap-4 py-6 text-center">
            <div className="h-14 w-14 rounded-full bg-muted flex items-center justify-center">
              <Phone className="h-7 w-7 text-muted-foreground" />
            </div>
            <div>
              <p className="font-medium">No phone number linked</p>
              <p className="text-sm text-muted-foreground mt-1">
                Link your WhatsApp number to receive order notifications and enable phone OTP login.
              </p>
            </div>
            <Link href="/phone-auth">
              <Button>
                <MessageSquare className="h-4 w-4 mr-2" />
                Link WhatsApp Number
              </Button>
            </Link>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Notification Preferences Card ────────────────────────────────────────────
interface NotifPref {
  key: "whatsappNotifOrders" | "whatsappNotifStatus" | "whatsappNotifMarketing";
  label: string;
  description: string;
  icon: React.ElementType;
  iconColor: string;
  iconBg: string;
}

const NOTIF_PREFS: NotifPref[] = [
  {
    key: "whatsappNotifOrders",
    label: "Order Confirmations",
    description: "Receive a WhatsApp message when a new order is placed or confirmed.",
    icon: ShoppingBag,
    iconColor: "text-blue-600",
    iconBg: "bg-blue-50",
  },
  {
    key: "whatsappNotifStatus",
    label: "Status Updates",
    description: "Get notified when your order is shipped, delivered, or cancelled.",
    icon: Truck,
    iconColor: "text-purple-600",
    iconBg: "bg-purple-50",
  },
  {
    key: "whatsappNotifMarketing",
    label: "Promotions & Marketing",
    description: "Receive promotional messages, special offers, and product announcements.",
    icon: Megaphone,
    iconColor: "text-orange-600",
    iconBg: "bg-orange-50",
  },
];

function NotificationPreferencesCard() {
  const utils = trpc.useUtils();
  const { data: status, isLoading } = trpc.phoneAuth.getPhoneStatus.useQuery();
  const [pendingKey, setPendingKey] = useState<string | null>(null);

  const updatePrefs = trpc.phoneAuth.updateNotifPrefs.useMutation({
    onMutate: ({ whatsappNotifOrders, whatsappNotifStatus, whatsappNotifMarketing }) => {
      // Optimistic update
      utils.phoneAuth.getPhoneStatus.setData(undefined, (old) => {
        if (!old) return old;
        return {
          ...old,
          ...(whatsappNotifOrders !== undefined && { whatsappNotifOrders }),
          ...(whatsappNotifStatus !== undefined && { whatsappNotifStatus }),
          ...(whatsappNotifMarketing !== undefined && { whatsappNotifMarketing }),
        };
      });
    },
    onSuccess: () => {
      setPendingKey(null);
      toast.success("Notification preferences saved.");
    },
    onError: (err) => {
      setPendingKey(null);
      utils.phoneAuth.getPhoneStatus.invalidate();
      toast.error(err.message);
    },
  });

  const handleToggle = (key: NotifPref["key"], value: boolean) => {
    setPendingKey(key);
    updatePrefs.mutate({ [key]: value });
  };

  const isDisabled = !status?.phoneVerified;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center">
            <Bell className="h-5 w-5 text-primary" />
          </div>
          <div>
            <CardTitle className="text-base">Notification Preferences</CardTitle>
            <CardDescription>
              {isDisabled
                ? "Verify your phone number to enable WhatsApp notifications."
                : "Choose which WhatsApp notifications you want to receive."}
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-1">
        {isDisabled && (
          <div className="flex items-center gap-2 p-3 mb-3 rounded-lg bg-muted/50 text-sm text-muted-foreground">
            <BellOff className="h-4 w-4 shrink-0" />
            <span>Notifications are disabled until you verify your phone number.</span>
          </div>
        )}
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          NOTIF_PREFS.map((pref, idx) => {
            const Icon = pref.icon;
            const checked = status?.[pref.key] ?? (pref.key !== "whatsappNotifMarketing");
            const isPending = pendingKey === pref.key;

            return (
              <div key={pref.key}>
                {idx > 0 && <Separator className="my-1" />}
                <div className={`flex items-center gap-4 py-3 px-1 rounded-lg transition-colors ${isDisabled ? "opacity-50" : ""}`}>
                  <div className={`h-9 w-9 rounded-lg ${pref.iconBg} flex items-center justify-center shrink-0`}>
                    <Icon className={`h-4.5 w-4.5 ${pref.iconColor}`} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <Label htmlFor={pref.key} className="text-sm font-medium cursor-pointer">
                      {pref.label}
                    </Label>
                    <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{pref.description}</p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {isPending && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
                    <Switch
                      id={pref.key}
                      checked={checked}
                      onCheckedChange={(val) => handleToggle(pref.key, val)}
                      disabled={isDisabled || updatePrefs.isPending}
                    />
                  </div>
                </div>
              </div>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────
// ── Notification History Card ─────────────────────────────────────────────────
type NotifStatus = "pending" | "sent" | "delivered" | "read" | "failed" | "simulated";

const STATUS_CONFIG: Record<NotifStatus, { label: string; icon: React.ElementType; className: string }> = {
  pending:   { label: "Pending",   icon: Clock,        className: "text-yellow-600 bg-yellow-50 border-yellow-200" },
  sent:      { label: "Sent",      icon: Send,         className: "text-blue-600 bg-blue-50 border-blue-200" },
  delivered: { label: "Delivered", icon: CheckCircle2, className: "text-green-600 bg-green-50 border-green-200" },
  read:      { label: "Read",      icon: Eye,          className: "text-purple-600 bg-purple-50 border-purple-200" },
  failed:    { label: "Failed",    icon: XCircle,      className: "text-red-600 bg-red-50 border-red-200" },
  simulated: { label: "Simulated", icon: Package,      className: "text-gray-600 bg-gray-50 border-gray-200" },
};

const NOTIF_TYPE_LABELS: Record<string, string> = {
  order_confirmation: "Order Confirmed",
  order_shipped:      "Order Shipped",
  order_delivered:    "Order Delivered",
  order_cancelled:    "Order Cancelled",
};

const PAGE_SIZE = 10;
function NotificationHistoryCard() {
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const timerRef = useState<ReturnType<typeof setTimeout> | null>(null);
  const handleSearchChange = (val: string) => {
    setSearch(val);
    if (timerRef[0]) clearTimeout(timerRef[0]);
    timerRef[1](setTimeout(() => { setDebouncedSearch(val); setPage(0); }, 350));
  };
  const hasFilters = !!(debouncedSearch || statusFilter || dateFrom || dateTo);
  const clearFilters = () => {
    setSearch(""); setDebouncedSearch(""); setStatusFilter(""); setDateFrom(""); setDateTo(""); setPage(0);
  };
  const { data, isLoading } = trpc.whatsappNotifications.getNotificationHistory.useQuery({
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
    search: debouncedSearch || undefined,
    status: statusFilter || undefined,
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
  });
  const logs = data?.logs ?? [];
  const hasNext = logs.length === PAGE_SIZE;
  const hasPrev = page > 0;
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-lg bg-muted flex items-center justify-center">
            <History className="h-5 w-5 text-muted-foreground" />
          </div>
          <div className="flex-1">
            <CardTitle className="text-base">Notification History</CardTitle>
            <CardDescription>Recent WhatsApp messages sent to your number</CardDescription>
          </div>
          {hasFilters && (
            <Button variant="ghost" size="sm" onClick={clearFilters} className="h-7 text-xs gap-1 text-muted-foreground">
              <X className="h-3 w-3" /> Clear filters
            </Button>
          )}
        </div>
        <div className="flex flex-wrap gap-2 pt-1">
          <div className="relative flex-1 min-w-[160px]">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
            <Input
              placeholder="Search by type, phone, WAMID…"
              value={search}
              onChange={(e) => handleSearchChange(e.target.value)}
              className="h-8 pl-8 text-xs"
            />
          </div>
          <Select value={statusFilter || "all"} onValueChange={(v) => { setStatusFilter(v === "all" ? "" : v); setPage(0); }}>
            <SelectTrigger className="h-8 w-[130px] text-xs">
              <Filter className="h-3 w-3 mr-1 text-muted-foreground" />
              <SelectValue placeholder="All statuses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="sent">Sent</SelectItem>
              <SelectItem value="delivered">Delivered</SelectItem>
              <SelectItem value="read">Read</SelectItem>
              <SelectItem value="failed">Failed</SelectItem>
              <SelectItem value="simulated">Simulated</SelectItem>
            </SelectContent>
          </Select>
          <Input
            type="date"
            value={dateFrom}
            onChange={(e) => { setDateFrom(e.target.value); setPage(0); }}
            className="h-8 w-[130px] text-xs"
            title="From date"
          />
          <Input
            type="date"
            value={dateTo}
            onChange={(e) => { setDateTo(e.target.value); setPage(0); }}
            className="h-8 w-[130px] text-xs"
            title="To date"
          />
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center justify-center py-10">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : logs.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-10 text-center">
            <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center">
              <History className="h-6 w-6 text-muted-foreground" />
            </div>
            <div>
              <p className="text-sm font-medium">No notifications yet</p>
              <p className="text-xs text-muted-foreground mt-1">
                Messages sent to your WhatsApp number will appear here.
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            {logs.map((log) => {
              const status = (log.status ?? "pending") as NotifStatus;
              const cfg = STATUS_CONFIG[status] ?? STATUS_CONFIG.pending;
              const Icon = cfg.icon;
              const typeLabel = NOTIF_TYPE_LABELS[log.notifType] ?? log.notifType;
              const sentAt = log.sentAt ? new Date(log.sentAt).toLocaleString() : null;
              const createdAt = new Date(log.createdAt).toLocaleString();

              return (
                <div
                  key={log.id}
                  className="flex items-start gap-3 p-3 rounded-lg border bg-card hover:bg-muted/30 transition-colors"
                >
                  <div className={`mt-0.5 h-7 w-7 rounded-full flex items-center justify-center shrink-0 border ${cfg.className}`}>
                    <Icon className="h-3.5 w-3.5" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm font-medium truncate">{typeLabel}</p>
                      <Badge
                        variant="outline"
                        className={`text-xs shrink-0 ${cfg.className}`}
                      >
                        {cfg.label}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5 font-mono">
                      {log.phone?.replace(/(\+\d{3})\d+(\d{4})/, "$1****$2")}
                      {log.orderId && (
                        <span className="ml-2 text-muted-foreground/70">
                          · Order {log.orderId.slice(0, 8)}…
                        </span>
                      )}
                    </p>
                    <p className="text-xs text-muted-foreground/60 mt-1">
                      {sentAt ? `Sent ${sentAt}` : `Queued ${createdAt}`}
                      {log.wamid && (
                        <span className="ml-2 font-mono text-[10px]">
                          WAMID: {log.wamid.slice(0, 16)}…
                        </span>
                      )}
                    </p>
                    {log.failReason && (
                      <p className="text-xs text-red-600 mt-1 flex items-center gap-1">
                        <XCircle className="h-3 w-3" />
                        {log.failReason}
                      </p>
                    )}
                  </div>
                </div>
              );
            })}

            {/* Pagination */}
            <div className="flex items-center justify-between pt-2">
              <p className="text-xs text-muted-foreground">
                Page {page + 1}
              </p>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  disabled={!hasPrev}
                  className="h-7 px-2"
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage((p) => p + 1)}
                  disabled={!hasNext}
                  className="h-7 px-2"
                >
                  <ChevronRight className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function WhatsAppProfilePage() {
  return (
    <DashboardLayout>
      <div className="space-y-6 max-w-2xl">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            <MessageSquare className="h-6 w-6 text-green-600" />
            WhatsApp Profile
          </h1>
          <p className="text-muted-foreground mt-1">
            Manage your linked WhatsApp number and control which notifications you receive.
          </p>
        </div>

        <LinkedNumberCard />
        <NotificationPreferencesCard />
        <NotificationHistoryCard />
      </div>
    </DashboardLayout>
  );
}
