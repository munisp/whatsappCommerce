/**
 * PhoneAuthPage — Phone OTP Authentication Management (Enhanced)
 *
 * Features:
 * - Searchable country code selector with flag emojis and dial codes
 * - 60-second countdown timer on resend OTP button with progress bar
 * - Live E.164 phone number formatting preview
 * - Phone verification card with status display
 * - Admin test panel for the full sendOtp → verifyOtp flow
 * - Architecture overview card
 */
import { useState, useEffect, useRef, useCallback } from "react";
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
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
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
  ChevronDown,
  Search,
  X,
} from "lucide-react";

// ── Country Code Data ─────────────────────────────────────────────────────────
const COUNTRIES = [
  { code: "NG", name: "Nigeria", dial: "+234", flag: "\u{1F1F3}\u{1F1EC}" },
  { code: "GH", name: "Ghana", dial: "+233", flag: "\u{1F1EC}\u{1F1ED}" },
  { code: "KE", name: "Kenya", dial: "+254", flag: "\u{1F1F0}\u{1F1EA}" },
  { code: "ZA", name: "South Africa", dial: "+27", flag: "\u{1F1FF}\u{1F1E6}" },
  { code: "EG", name: "Egypt", dial: "+20", flag: "\u{1F1EA}\u{1F1EC}" },
  { code: "ET", name: "Ethiopia", dial: "+251", flag: "\u{1F1EA}\u{1F1F9}" },
  { code: "TZ", name: "Tanzania", dial: "+255", flag: "\u{1F1F9}\u{1F1FF}" },
  { code: "UG", name: "Uganda", dial: "+256", flag: "\u{1F1FA}\u{1F1EC}" },
  { code: "SN", name: "Senegal", dial: "+221", flag: "\u{1F1F8}\u{1F1F3}" },
  { code: "CI", name: "Cote d\'Ivoire", dial: "+225", flag: "\u{1F1E8}\u{1F1EE}" },
  { code: "CM", name: "Cameroon", dial: "+237", flag: "\u{1F1E8}\u{1F1F2}" },
  { code: "RW", name: "Rwanda", dial: "+250", flag: "\u{1F1F7}\u{1F1FC}" },
  { code: "ZM", name: "Zambia", dial: "+260", flag: "\u{1F1FF}\u{1F1F2}" },
  { code: "ZW", name: "Zimbabwe", dial: "+263", flag: "\u{1F1FF}\u{1F1FC}" },
  { code: "MA", name: "Morocco", dial: "+212", flag: "\u{1F1F2}\u{1F1E6}" },
  { code: "TN", name: "Tunisia", dial: "+216", flag: "\u{1F1F9}\u{1F1F3}" },
  { code: "AO", name: "Angola", dial: "+244", flag: "\u{1F1E6}\u{1F1F4}" },
  { code: "MZ", name: "Mozambique", dial: "+258", flag: "\u{1F1F2}\u{1F1FF}" },
  { code: "BJ", name: "Benin", dial: "+229", flag: "\u{1F1E7}\u{1F1EF}" },
  { code: "TG", name: "Togo", dial: "+228", flag: "\u{1F1F9}\u{1F1EC}" },
  { code: "GB", name: "United Kingdom", dial: "+44", flag: "\u{1F1EC}\u{1F1E7}" },
  { code: "US", name: "United States", dial: "+1", flag: "\u{1F1FA}\u{1F1F8}" },
  { code: "IN", name: "India", dial: "+91", flag: "\u{1F1EE}\u{1F1F3}" },
  { code: "BR", name: "Brazil", dial: "+55", flag: "\u{1F1E7}\u{1F1F7}" },
  { code: "DE", name: "Germany", dial: "+49", flag: "\u{1F1E9}\u{1F1EA}" },
  { code: "FR", name: "France", dial: "+33", flag: "\u{1F1EB}\u{1F1F7}" },
  { code: "AE", name: "UAE", dial: "+971", flag: "\u{1F1E6}\u{1F1EA}" },
  { code: "SA", name: "Saudi Arabia", dial: "+966", flag: "\u{1F1F8}\u{1F1E6}" },
  { code: "CN", name: "China", dial: "+86", flag: "\u{1F1E8}\u{1F1F3}" },
  { code: "JP", name: "Japan", dial: "+81", flag: "\u{1F1EF}\u{1F1F5}" },
] as const;

type Country = (typeof COUNTRIES)[number];

// ── Country Code Selector ─────────────────────────────────────────────────────
function CountryCodeSelector({
  value,
  onChange,
}: {
  value: Country;
  onChange: (c: Country) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  const filtered = COUNTRIES.filter(
    (c) =>
      c.name.toLowerCase().includes(search.toLowerCase()) ||
      c.dial.includes(search) ||
      c.code.toLowerCase().includes(search.toLowerCase())
  );

  useEffect(() => {
    if (open) setTimeout(() => searchRef.current?.focus(), 50);
  }, [open]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-[110px] justify-between px-2.5 shrink-0 font-normal"
        >
          <span className="flex items-center gap-1.5 min-w-0">
            <span className="text-base leading-none">{value.flag}</span>
            <span className="text-sm font-medium">{value.dial}</span>
          </span>
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[280px] p-0" align="start">
        <div className="flex items-center border-b px-3">
          <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0 mr-2" />
          <input
            ref={searchRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search country or code..."
            className="flex-1 py-2.5 text-sm bg-transparent outline-none placeholder:text-muted-foreground"
          />
          {search && (
            <button onClick={() => setSearch("")} className="text-muted-foreground hover:text-foreground">
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <div className="max-h-[240px] overflow-y-auto">
          {filtered.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">No countries found</p>
          ) : (
            filtered.map((c) => (
              <button
                key={c.code}
                onClick={() => { onChange(c); setOpen(false); setSearch(""); }}
                className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm hover:bg-accent text-left transition-colors ${
                  value.code === c.code ? "bg-accent/60 font-medium" : ""
                }`}
              >
                <span className="text-base leading-none w-6 text-center">{c.flag}</span>
                <span className="flex-1 min-w-0 truncate">{c.name}</span>
                <span className="text-muted-foreground font-mono text-xs shrink-0">{c.dial}</span>
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ── Countdown Hook ────────────────────────────────────────────────────────────
function useCountdown(seconds: number) {
  const [remaining, setRemaining] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const start = useCallback(() => {
    setRemaining(seconds);
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      setRemaining((prev) => {
        if (prev <= 1) {
          clearInterval(timerRef.current!);
          timerRef.current = null;
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  }, [seconds]);

  const reset = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    setRemaining(0);
  }, []);

  useEffect(() => () => { if (timerRef.current) clearInterval(timerRef.current); }, []);

  return { remaining, isActive: remaining > 0, start, reset };
}

// ── Phone Verification Card ───────────────────────────────────────────────────
function PhoneVerificationCard() {
  const [country, setCountry] = useState<Country>(COUNTRIES[0]);
  const [localNumber, setLocalNumber] = useState("");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [otp, setOtp] = useState("");
  const [verified, setVerified] = useState(false);
  const countdown = useCountdown(60);

  const { data: status, refetch: refetchStatus } = trpc.phoneAuth.getPhoneStatus.useQuery();

  const fullPhone = `${country.dial}${localNumber.replace(/\D/g, "")}`;
  const isValidPhone = /^\+\d{7,15}$/.test(fullPhone);

  const sendOtp = trpc.phoneAuth.linkPhone.useMutation({
    onSuccess: (data) => {
      setSessionId(data.sessionId);
      countdown.start();
      toast.success("OTP sent via WhatsApp! Check your messages.");
    },
    onError: (err) => toast.error(err.message),
  });

  const verifyOtp = trpc.phoneAuth.verifyOtp.useMutation({
    onSuccess: () => {
      setVerified(true);
      setSessionId(null);
      setOtp("");
      countdown.reset();
      refetchStatus();
      toast.success("Phone number verified successfully!");
    },
    onError: (err) => {
      toast.error(err.message);
      setOtp("");
    },
  });

  const handleSendOtp = () => {
    if (!isValidPhone) { toast.error("Please enter a valid phone number."); return; }
    sendOtp.mutate({ phone: fullPhone });
  };

  const handleVerifyOtp = () => {
    if (!sessionId || otp.length !== 6) return;
    verifyOtp.mutate({ sessionId, otp });
  };

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
        {status && (
          <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/40">
            {status.phoneVerified ? (
              <CheckCircle2 className="h-4 w-4 text-green-500 shrink-0" />
            ) : (
              <AlertCircle className="h-4 w-4 text-muted-foreground shrink-0" />
            )}
            <div className="min-w-0">
              <p className="text-sm font-medium">{status.phoneVerified ? "Phone verified" : "No verified phone"}</p>
              {status.phone && <p className="text-xs text-muted-foreground truncate">{status.phone}</p>}
            </div>
            {status.phoneVerified && (
              <Badge variant="secondary" className="ml-auto shrink-0 text-green-600 bg-green-50">Verified</Badge>
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
          <div className="space-y-3">
            <label className="text-sm font-medium block">Phone Number</label>
            <div className="flex gap-2">
              <CountryCodeSelector value={country} onChange={setCountry} />
              <div className="flex-1 relative">
                <Input
                  placeholder="800 000 0000"
                  value={localNumber}
                  onChange={(e) => setLocalNumber(e.target.value.replace(/[^\d\s\-()]/g, ""))}
                  onKeyDown={(e) => e.key === "Enter" && handleSendOtp()}
                  className="pr-28"
                />
                {localNumber && isValidPhone && (
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground font-mono pointer-events-none">
                    {fullPhone}
                  </span>
                )}
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Select your country, then enter your local number.
              {isValidPhone && <span className="ml-1 font-mono text-foreground">{fullPhone}</span>}
            </p>
            <Button onClick={handleSendOtp} disabled={sendOtp.isPending || !isValidPhone} className="w-full">
              {sendOtp.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <MessageSquare className="h-4 w-4 mr-2" />}
              Send OTP via WhatsApp
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center justify-between text-sm">
              <div className="flex items-center gap-2 text-muted-foreground">
                <Clock className="h-3.5 w-3.5" />
                <span>OTP sent to <span className="font-mono font-medium text-foreground">{fullPhone}</span></span>
              </div>
              <button
                onClick={() => { setSessionId(null); setOtp(""); countdown.reset(); }}
                className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2"
              >
                Change number
              </button>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium block">Enter 6-digit OTP</label>
              <InputOTP maxLength={6} value={otp} onChange={setOtp} onComplete={handleVerifyOtp}>
                <InputOTPGroup>
                  <InputOTPSlot index={0} /><InputOTPSlot index={1} /><InputOTPSlot index={2} />
                </InputOTPGroup>
                <InputOTPSeparator />
                <InputOTPGroup>
                  <InputOTPSlot index={3} /><InputOTPSlot index={4} /><InputOTPSlot index={5} />
                </InputOTPGroup>
              </InputOTP>
            </div>

            <div className="flex gap-2">
              <Button onClick={handleVerifyOtp} disabled={verifyOtp.isPending || otp.length !== 6} className="flex-1">
                {verifyOtp.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <CheckCircle2 className="h-4 w-4 mr-2" />}
                Verify OTP
              </Button>
              <Button
                variant="outline"
                onClick={() => { setSessionId(null); setOtp(""); handleSendOtp(); }}
                disabled={countdown.isActive || sendOtp.isPending}
                className="min-w-[120px]"
                title={countdown.isActive ? `Resend in ${countdown.remaining}s` : "Resend OTP"}
              >
                {countdown.isActive ? (
                  <>
                    <Clock className="h-3.5 w-3.5 mr-1.5 text-muted-foreground" />
                    <span className="font-mono text-sm tabular-nums">{countdown.remaining}s</span>
                  </>
                ) : sendOtp.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <><RefreshCw className="h-3.5 w-3.5 mr-1.5" />Resend</>
                )}
              </Button>
            </div>

            {countdown.isActive && (
              <div className="space-y-1">
                <div className="h-1 w-full bg-muted rounded-full overflow-hidden">
                  <div
                    className="h-full bg-primary rounded-full transition-all duration-1000 ease-linear"
                    style={{ width: `${(countdown.remaining / 60) * 100}%` }}
                  />
                </div>
                <p className="text-xs text-muted-foreground text-center">
                  Resend available in {countdown.remaining} second{countdown.remaining !== 1 ? "s" : ""}
                </p>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── OTP Test Panel ────────────────────────────────────────────────────────────
function OtpTestPanel() {
  const [country, setCountry] = useState<Country>(COUNTRIES[0]);
  const [localNumber, setLocalNumber] = useState("");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [otp, setOtp] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const countdown = useCountdown(60);

  const fullPhone = `${country.dial}${localNumber.replace(/\D/g, "")}`;
  const isValidPhone = /^\+\d{7,15}$/.test(fullPhone);

  const sendOtp = trpc.phoneAuth.sendOtp.useMutation({
    onSuccess: (data) => {
      setSessionId(data.sessionId);
      countdown.start();
      setResult(`OTP sent — session: ${data.sessionId.slice(0, 8)}...`);
    },
    onError: (err) => setResult(`Error: ${err.message}`),
  });

  const verifyOtp = trpc.phoneAuth.verifyOtp.useMutation({
    onSuccess: (data) => {
      setResult(JSON.stringify(data, null, 2));
      setSessionId(null);
      countdown.reset();
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
              Test the full sendOtp → verifyOtp flow. In simulation mode (no WAC_WHATSAPP_TOKEN), OTP is logged to server console.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <label className="text-sm font-medium block">Test Phone Number</label>
          <div className="flex gap-2">
            <CountryCodeSelector value={country} onChange={setCountry} />
            <Input
              placeholder="800 000 0000"
              value={localNumber}
              onChange={(e) => setLocalNumber(e.target.value.replace(/[^\d\s\-()]/g, ""))}
              className="flex-1"
            />
          </div>
        </div>

        <Button
          onClick={() => sendOtp.mutate({ phone: fullPhone, purpose: "login" })}
          disabled={sendOtp.isPending || !isValidPhone}
          variant="outline"
          className="w-full"
        >
          {sendOtp.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <MessageSquare className="h-4 w-4 mr-2" />}
          Send Test OTP
        </Button>

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
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => sendOtp.mutate({ phone: fullPhone, purpose: "login" })}
                disabled={countdown.isActive || sendOtp.isPending}
                className="text-xs"
              >
                {countdown.isActive ? (
                  <><Clock className="h-3 w-3 mr-1" /><span className="font-mono tabular-nums">{countdown.remaining}s</span></>
                ) : (
                  <><RefreshCw className="h-3 w-3 mr-1" />Resend</>
                )}
              </Button>
              {countdown.isActive && (
                <div className="flex-1 h-1 bg-muted rounded-full overflow-hidden">
                  <div
                    className="h-full bg-orange-400 rounded-full transition-all duration-1000 ease-linear"
                    style={{ width: `${(countdown.remaining / 60) * 100}%` }}
                  />
                </div>
              )}
            </div>
          </div>
        )}

        {result && (
          <pre className="text-xs bg-muted/40 rounded-lg p-3 overflow-auto max-h-40 font-mono whitespace-pre-wrap break-all">
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
    { icon: Phone, title: "1. Phone Entry", desc: "User enters phone number on Keycloak login page (custom Freemarker template)", color: "text-blue-500", bg: "bg-blue-50" },
    { icon: MessageSquare, title: "2. WhatsApp OTP", desc: "Keycloak SPI calls WhatsApp Cloud API to send a 6-digit OTP via template message", color: "text-green-500", bg: "bg-green-50" },
    { icon: KeyRound, title: "3. OTP Verification", desc: "User enters OTP on the Keycloak OTP entry page; SPI validates against Redis/memory store", color: "text-orange-500", bg: "bg-orange-50" },
    { icon: Shield, title: "4. JWT Issued", desc: "Keycloak issues a signed JWT; APISIX validates it on every API request via openid-connect plugin", color: "text-purple-500", bg: "bg-purple-50" },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Authentication Architecture</CardTitle>
        <CardDescription>How the Keycloak WhatsApp OTP SPI integrates with the platform</CardDescription>
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
      <div className="space-y-6 max-w-2xl">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            <Shield className="h-6 w-6 text-primary" />
            Phone Authentication
          </h1>
          <p className="text-muted-foreground mt-1">
            Link and verify your WhatsApp number to enable OTP-based authentication and order notifications.
          </p>
        </div>
        <PhoneVerificationCard />
        <OtpTestPanel />
        <ArchitectureCard />
      </div>
    </DashboardLayout>
  );
}
