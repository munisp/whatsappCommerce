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
      </div>
    </DashboardLayout>
  );
}
