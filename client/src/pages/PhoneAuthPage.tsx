/**
 * PhoneAuthPage — Phone OTP Authentication Management
 *
 * Provides two flows:
 * 1. "Link Phone" — authenticated users can link and verify a phone number via WhatsApp OTP
 * 2. "Test OTP Flow" — admin panel to test the full sendOtp → verifyOtp flow
 *
 * The Keycloak WhatsApp OTP SPI JAR implements the same flow inside Keycloak's
 * authentication pipeline. This page is the platform-side management UI.
 */
import { useState } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
  InputOTPSeparator,
} from "@/components/ui/input-otp";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import {
  Phone,
  CheckCircle2,
  KeyRound,
  Shield,
  AlertCircle,
  Loader2,
  MessageSquare,
  Clock,
  RefreshCw,
} from "lucide-react";

// ── Phone Verification Card ───────────────────────────────────────────────────

function PhoneVerificationCard() {
  const [phone, setPhone] = useState("");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [otp, setOtp] = useState("");
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [verified, setVerified] = useState(false);

  const { data: status, refetch: refetchStatus } = trpc.phoneAuth.getPhoneStatus.useQuery();

  const sendOtp = trpc.phoneAuth.linkPhone.useMutation({
    onSuccess: (data) => {
      setSessionId(data.sessionId);
      setExpiresAt(data.expiresAt);
      toast.success("OTP sent via WhatsApp! Check your messages.");
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  const verifyOtp = trpc.phoneAuth.verifyOtp.useMutation({
    onSuccess: () => {
      setVerified(true);
      setSessionId(null);
      setOtp("");
      refetchStatus();
      toast.success("Phone number verified successfully!");
    },
    onError: (err) => {
      toast.error(err.message);
      setOtp("");
    },
  });

  const handleSendOtp = () => {
    if (!phone.trim()) {
      toast.error("Please enter a phone number.");
      return;
    }
    sendOtp.mutate({ phone: phone.trim() });
  };

  const handleVerifyOtp = () => {
    if (!sessionId || otp.length !== 6) return;
    verifyOtp.mutate({ sessionId, otp });
  };

  const minutesLeft = expiresAt ? Math.max(0, Math.ceil((expiresAt - Date.now()) / 60000)) : 0;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center">
            <Phone className="h-5 w-5 text-primary" />
          </div>
          <div>
            <CardTitle className="text-base">Phone Verification</CardTitle>
            <CardDescription>Link and verify your phone number via WhatsApp OTP</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Current Status */}
        {status && (
          <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/40">
            {status.phoneVerified ? (
              <CheckCircle2 className="h-4 w-4 text-green-500 shrink-0" />
            ) : (
              <AlertCircle className="h-4 w-4 text-muted-foreground shrink-0" />
            )}
            <div className="min-w-0">
              <p className="text-sm font-medium">
                {status.phoneVerified ? "Phone verified" : "No verified phone"}
              </p>
              {status.phone && (
                <p className="text-xs text-muted-foreground truncate">{status.phone}</p>
              )}
            </div>
            {status.phoneVerified && (
              <Badge variant="secondary" className="ml-auto shrink-0 text-green-600 bg-green-50">
                Verified
              </Badge>
            )}
          </div>
        )}

        {verified && (
          <Alert className="border-green-200 bg-green-50">
            <CheckCircle2 className="h-4 w-4 text-green-600" />
            <AlertDescription className="text-green-700">
              Phone number successfully verified and linked to your account.
            </AlertDescription>
          </Alert>
        )}

        <Separator />

        {!sessionId ? (
          /* Step 1: Enter phone number */
          <div className="space-y-3">
            <div>
              <label className="text-sm font-medium mb-1.5 block">Phone Number</label>
              <div className="flex gap-2">
                <Input
                  placeholder="+234 800 000 0000"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleSendOtp()}
                  className="flex-1"
                />
                <Button
                  onClick={handleSendOtp}
                  disabled={sendOtp.isPending || !phone.trim()}
                >
                  {sendOtp.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <MessageSquare className="h-4 w-4" />
                  )}
                  <span className="ml-1.5">Send OTP</span>
                </Button>
              </div>
              <p className="text-xs text-muted-foreground mt-1.5">
                Enter your number in international format (e.g. +234 for Nigeria)
              </p>
            </div>
          </div>
        ) : (
          /* Step 2: Enter OTP */
          <div className="space-y-4">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Clock className="h-3.5 w-3.5" />
              <span>OTP sent to {phone} — expires in {minutesLeft} min</span>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium block">Enter 6-digit OTP</label>
              <InputOTP
                maxLength={6}
                value={otp}
                onChange={setOtp}
                onComplete={handleVerifyOtp}
              >
                <InputOTPGroup>
                  <InputOTPSlot index={0} />
                  <InputOTPSlot index={1} />
                  <InputOTPSlot index={2} />
                </InputOTPGroup>
                <InputOTPSeparator />
                <InputOTPGroup>
                  <InputOTPSlot index={3} />
                  <InputOTPSlot index={4} />
                  <InputOTPSlot index={5} />
                </InputOTPGroup>
              </InputOTP>
            </div>

            <div className="flex gap-2">
              <Button
                onClick={handleVerifyOtp}
                disabled={verifyOtp.isPending || otp.length !== 6}
                className="flex-1"
              >
                {verifyOtp.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <CheckCircle2 className="h-4 w-4" />
                )}
                <span className="ml-1.5">Verify OTP</span>
              </Button>
              <Button
                variant="outline"
                onClick={() => { setSessionId(null); setOtp(""); }}
              >
                <RefreshCw className="h-4 w-4" />
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── OTP Test Panel ────────────────────────────────────────────────────────────

function OtpTestPanel() {
  const [phone, setPhone] = useState("");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [otp, setOtp] = useState("");
  const [result, setResult] = useState<string | null>(null);

  const sendOtp = trpc.phoneAuth.sendOtp.useMutation({
    onSuccess: (data) => {
      setSessionId(data.sessionId);
      setResult(null);
      toast.success(`OTP session created. Session ID: ${data.sessionId.slice(0, 8)}...`);
    },
    onError: (err) => toast.error(err.message),
  });

  const verifyOtp = trpc.phoneAuth.verifyOtp.useMutation({
    onSuccess: (data) => {
      setResult(JSON.stringify(data, null, 2));
      setSessionId(null);
      setOtp("");
      toast.success("OTP verified successfully!");
    },
    onError: (err) => {
      toast.error(err.message);
      setOtp("");
    },
  });

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-lg bg-orange-500/10 flex items-center justify-center">
            <KeyRound className="h-5 w-5 text-orange-500" />
          </div>
          <div>
            <CardTitle className="text-base">OTP Flow Test Panel</CardTitle>
            <CardDescription>
              Test the full sendOtp → verifyOtp flow. In simulation mode (no WAC_WHATSAPP_TOKEN set),
              the OTP is logged to the server console.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-sm font-medium mb-1.5 block">Phone Number</label>
            <Input
              placeholder="+234 800 000 0000"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
          </div>
          <div className="flex items-end">
            <Button
              onClick={() => sendOtp.mutate({ phone, purpose: "login" })}
              disabled={sendOtp.isPending || !phone.trim()}
              className="w-full"
            >
              {sendOtp.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <MessageSquare className="h-4 w-4" />}
              <span className="ml-1.5">Send OTP</span>
            </Button>
          </div>
        </div>

        {sessionId && (
          <div className="space-y-3 p-3 rounded-lg border border-dashed">
            <p className="text-xs text-muted-foreground font-mono">Session: {sessionId}</p>
            <div className="flex gap-2">
              <Input
                placeholder="6-digit OTP"
                maxLength={6}
                value={otp}
                onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))}
                className="font-mono tracking-widest"
              />
              <Button
                onClick={() => verifyOtp.mutate({ sessionId, otp })}
                disabled={verifyOtp.isPending || otp.length !== 6}
              >
                {verifyOtp.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Verify"}
              </Button>
            </div>
          </div>
        )}

        {result && (
          <pre className="text-xs bg-muted/40 rounded-lg p-3 overflow-auto max-h-40 font-mono">
            {result}
          </pre>
        )}
      </CardContent>
    </Card>
  );
}

// ── Architecture Overview ─────────────────────────────────────────────────────

function ArchitectureCard() {
  const steps = [
    {
      icon: Phone,
      title: "1. Phone Entry",
      desc: "User enters phone number on Keycloak login page (custom Freemarker template)",
      color: "text-blue-500",
      bg: "bg-blue-50",
    },
    {
      icon: MessageSquare,
      title: "2. WhatsApp OTP",
      desc: "Keycloak SPI calls WhatsApp Cloud API to send a 6-digit OTP via template message",
      color: "text-green-500",
      bg: "bg-green-50",
    },
    {
      icon: KeyRound,
      title: "3. OTP Verification",
      desc: "User enters OTP on the Keycloak OTP entry page; SPI validates against Redis/memory store",
      color: "text-orange-500",
      bg: "bg-orange-50",
    },
    {
      icon: Shield,
      title: "4. JWT Issued",
      desc: "Keycloak issues a signed JWT; APISIX validates it on every API request via openid-connect plugin",
      color: "text-purple-500",
      bg: "bg-purple-50",
    },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Authentication Architecture</CardTitle>
        <CardDescription>
          How the Keycloak WhatsApp OTP SPI integrates with the platform
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-3">
          {steps.map((step) => (
            <div key={step.title} className="flex gap-3 p-3 rounded-lg bg-muted/30">
              <div className={`h-8 w-8 rounded-md ${step.bg} flex items-center justify-center shrink-0`}>
                <step.icon className={`h-4 w-4 ${step.color}`} />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-medium">{step.title}</p>
                <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{step.desc}</p>
              </div>
            </div>
          ))}
        </div>

        <Separator className="my-4" />

        <div className="space-y-2">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Environment Variables Required</p>
          <div className="grid grid-cols-2 gap-1.5">
            {[
              { key: "WAC_WHATSAPP_TOKEN", desc: "WhatsApp Cloud API access token" },
              { key: "WAC_WHATSAPP_PHONE_ID", desc: "WhatsApp Business phone number ID" },
              { key: "WAC_WHATSAPP_OTP_TEMPLATE", desc: "Template name (default: wac_otp)" },
              { key: "WAC_WHATSAPP_TEMPLATE_LANG", desc: "Template language (default: en_US)" },
            ].map((env) => (
              <div key={env.key} className="p-2 rounded bg-muted/40">
                <code className="text-xs font-mono text-primary">{env.key}</code>
                <p className="text-xs text-muted-foreground mt-0.5">{env.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function PhoneAuthPage() {
  return (
    <DashboardLayout>
      <div className="p-6 space-y-6 max-w-5xl">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Phone Authentication</h1>
          <p className="text-sm text-muted-foreground mt-1">
            WhatsApp OTP authentication via Keycloak SPI — link phone numbers and test the OTP flow
          </p>
        </div>

        <div className="grid grid-cols-2 gap-6">
          <div className="space-y-6">
            <PhoneVerificationCard />
            <OtpTestPanel />
          </div>
          <div>
            <ArchitectureCard />
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}
