import { useState, useRef, useCallback, useEffect } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import {
  Camera,
  Upload,
  Cpu,
  CheckCircle,
  AlertCircle,
  Eye,
  Package,
  Layers,
  RefreshCw,
  History,
  Zap,
  ChevronDown,
  ChevronUp,
  ClipboardCheck,
  ImageIcon,
  X,
} from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { toast } from "sonner";

// ── Types ─────────────────────────────────────────────────────────────────────
interface DetectedItem {
  label: string;
  count: number;
  confidence: number;
  location?: string;
  notes?: string;
}

interface AnalysisResult {
  sessionId: string;
  itemsDetected: number;
  totalCount: number;
  confidenceScore: number;
  items: DetectedItem[];
  sceneDescription: string;
  vlmModelUsed: string;
  processingMs: number;
  imageUrl: string;
}

/** Phone photos are several MB; the model reads at about 1000px anyway, so send a small JPEG instead. */
async function shrinkImage(source: Blob | HTMLCanvasElement, maxSide = 1280): Promise<string> {
  const bitmap = source instanceof HTMLCanvasElement ? source : await createImageBitmap(source);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.85);
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface ApplyRow { detectedLabel: string; confirmedCount: number; include: boolean; target: string; newName: string; newPrice: string }

/** The product whose name shares the most words with what the scan saw. */
function bestMatch<T extends { id: string; name: string }>(label: string, list: T[]): T | undefined {
  const words = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 2).map((w) => w.replace(/e?s$/, "")));
  const want = words(label);
  let best: T | undefined; let score = 0;
  for (const p of list) {
    const have = words(p.name);
    const hits = Array.from(want).filter((w) => have.has(w)).length;
    const s = hits / Math.max(want.size, 1);
    if (s > score) { score = s; best = p; }
  }
  return score >= 0.5 ? best : undefined;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function confidenceColor(c: number): string {
  if (c >= 0.8) return "text-emerald-600";
  if (c >= 0.6) return "text-amber-600";
  return "text-red-500";
}

function confidenceBadge(c: number): "default" | "secondary" | "destructive" {
  if (c >= 0.8) return "default";
  if (c >= 0.6) return "secondary";
  return "destructive";
}

// ── Main Component ────────────────────────────────────────────────────────────
export function VisualInventoryContent() {
  const [capturedImage, setCapturedImage] = useState<string | null>(null);
  const [capturedMime, setCapturedMime] = useState<"image/jpeg" | "image/png" | "image/webp">("image/jpeg");
  const [locationName, setLocationName] = useState("");
  const [productHints, setProductHints] = useState("");
  const [vlmModel, setVlmModel] = useState("");
  const [analysisResult, setAnalysisResult] = useState<AnalysisResult | null>(null);
  const [isAnalysing, setIsAnalysing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [activeTab, setActiveTab] = useState<"capture" | "history">("capture");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Inline count correction state
  const [inlineEditing, setInlineEditing] = useState<{ sessionId: string; label: string; count: number } | null>(null);
  const [inlineEditValue, setInlineEditValue] = useState<number>(0);
  // FMCG autocomplete state
  const [hintsQuery, setHintsQuery] = useState("");
  const [showHintsSuggestions, setShowHintsSuggestions] = useState(false);
  const [scanLocationInput, setScanLocationInput] = useState("");
  const [cameraActive, setCameraActive] = useState(false);

  const [selectedSession, setSelectedSession] = useState<string | null>(null);
  const [expandedSessionId, setExpandedSessionId] = useState<string | null>(null);
  const [applyDialogOpen, setApplyDialogOpen] = useState(false);
  const [applyAdjustments, setApplyAdjustments] = useState<ApplyRow[]>([]);
  const { data: catalog } = trpc.visualInventory.catalog.useQuery();
  const { data: mappings } = trpc.visualInventory.getMappings.useQuery();
  /** Opens the review step for a scan: each item matched to a product where possible, otherwise offered as new. */
  const openApply = (sessionId: string, items: DetectedItem[]) => {
    setApplyAdjustments(items.map((i) => {
      const mapped = mappings?.find((m) => m.detectedLabel === i.label)?.productId;
      const match = mapped && catalog?.some((p) => p.id === mapped) ? mapped : bestMatch(i.label, catalog ?? [])?.id;
      return { detectedLabel: i.label, confirmedCount: i.count, include: true, target: match ?? "new", newName: i.label, newPrice: "" };
    }));
    setSelectedSession(sessionId);
    setApplyDialogOpen(true);
  };

  const analyseMutation = trpc.visualInventory.analyseImage.useMutation();
  const utils = trpc.useUtils();
  const nativeCameraRef = useRef<HTMLInputElement>(null);
  const { data: sessions, refetch: refetchSessions } = trpc.visualInventory.listSessions.useQuery({ limit: 20 });
  const { data: modelsData } = trpc.visualInventory.getOllamaModels.useQuery();
  // FMCG taxonomy autocomplete
  const { data: hintsData } = trpc.taxonomy.searchHints.useQuery(
    { query: hintsQuery, limit: 8 },
    { enabled: hintsQuery.length >= 2 }
  );
  const addCorrectionMutation = trpc.viCorrections.saveCorrection.useMutation({
    onSuccess: () => {
      toast.success("Correction saved — this will improve future AI accuracy");
      setInlineEditing(null);
      refetchSessions();
    },
    onError: (err: { message: string }) => toast.error(err.message),
  });
  const applyMutation = trpc.visualInventory.applyToInventory.useMutation({
    onSuccess: (result) => {
      const made = result.created?.length ?? 0;
      toast.success(made ? `Added ${made} new product(s) and updated stock for ${result.applied} in total` : `Stock updated for ${result.applied} product(s)`);
      void utils.visualInventory.catalog.invalidate();
      setApplyDialogOpen(false);
      refetchSessions();
    },
    onError: (err) => toast.error(`Apply failed: ${err.message}`),
  });

  // ── Camera ────────────────────────────────────────────────────────────────
  const startCamera = useCallback(async () => {
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        // Some phone browsers have no live camera here; their own camera app still works.
        nativeCameraRef.current?.click();
        return;
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1080 } },
      });
      // The video element is always on the page, so the stream has somewhere to go.
      if (!videoRef.current) { stream.getTracks().forEach((t) => t.stop()); return; }
      videoRef.current.srcObject = stream;
      await videoRef.current.play().catch(() => undefined);
      setCameraActive(true);
    } catch (err) {
      const name = (err as { name?: string })?.name;
      if (name === "NotAllowedError") toast.error("Camera blocked. Allow camera access for this site in your browser settings, or use Take photo.");
      else nativeCameraRef.current?.click();
    }
  }, []);

  const stopCamera = useCallback(() => {
    if (videoRef.current?.srcObject) {
      const stream = videoRef.current.srcObject as MediaStream;
      stream.getTracks().forEach((t) => t.stop());
      videoRef.current.srcObject = null;
      setCameraActive(false);
    }
  }, []);

  const capturePhoto = useCallback(() => {
    if (!videoRef.current || !canvasRef.current) return;
    const video = videoRef.current;
    const canvas = canvasRef.current;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(video, 0, 0);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.9);
    void shrinkImage(canvas).then(setCapturedImage);
    void dataUrl;
    setCapturedMime("image/jpeg");
    stopCamera();
    toast.success("Photo captured!");
  }, [stopCamera]);

  // ── File Upload ───────────────────────────────────────────────────────────
  const handleFileUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      setCapturedImage(await shrinkImage(file));
      setCapturedMime("image/jpeg");
    } catch {
      toast.error("That image couldn't be opened. Try a JPG or PNG.");
    }
  }, []);

  // ── Analysis ──────────────────────────────────────────────────────────────
  const runAnalysis = useCallback(async () => {
    if (!capturedImage) {
      toast.error("Please capture or upload an image first.");
      return;
    }
    if (!locationName.trim()) {
      toast.error("Please enter a location name.");
      return;
    }

    setIsAnalysing(true);
    setProgress(10);

    // Simulate progress while waiting
    const progressInterval = setInterval(() => {
      setProgress((p) => Math.min(p + 5, 85));
    }, 1500);

    try {
      // Strip data URL prefix to get pure base64
      const base64 = capturedImage.replace(/^data:[^;]+;base64,/, "");
      const hints = productHints
        .split(",")
        .map((h) => h.trim())
        .filter(Boolean);

      const started = await analyseMutation.mutateAsync({
        imageBase64: base64,
        mimeType: capturedMime,
        locationName: locationName.trim(),
        scanLocation: scanLocationInput.trim() || locationName.trim(),
        notes: "",
        productHints: hints,
        vlmModel: vlmModel || undefined,
      });
      // The analysis runs on the server for a minute or two; check back until it's done.
      const deadline = Date.now() + 9 * 60_000;
      let session = await utils.visualInventory.getSession.fetch({ sessionId: started.sessionId });
      while (session.status === "processing" && Date.now() < deadline) {
        await wait(4000);
        session = await utils.visualInventory.getSession.fetch({ sessionId: started.sessionId });
      }
      if (session.status !== "completed") throw new Error(session.errorMessage || "The analysis didn't finish. Please try again.");
      const items = (session.detectedItems ?? []) as DetectedItem[];
      const totalCount = items.reduce((n, i) => n + i.count, 0);
      const result: AnalysisResult = {
        sessionId: session.id,
        itemsDetected: items.length,
        totalCount,
        confidenceScore: totalCount ? items.reduce((n, i) => n + i.confidence * i.count, 0) / totalCount : 0,
        items,
        sceneDescription: session.vlmAnalysis ?? "",
        vlmModelUsed: session.modelUsed ?? "",
        processingMs: session.processingMs ?? 0,
        imageUrl: session.imageUrl,
      };

      setProgress(100);
      setAnalysisResult(result);
      refetchSessions();
      toast.success(`Analysis complete! Detected ${result.itemsDetected} product types.`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Analysis failed";
      toast.error(/fetch failed|unable to transform|Failed to fetch/i.test(msg) ? "Shelf analysis couldn't be reached. Please try again in a minute." : msg);
    } finally {
      clearInterval(progressInterval);
      setIsAnalysing(false);
    }
  }, [capturedImage, capturedMime, locationName, productHints, vlmModel, analyseMutation, refetchSessions, utils, scanLocationInput]);

  const reset = () => {
    setCapturedImage(null);
    setAnalysisResult(null);
    setProgress(0);
    setLocationName("");
    setScanLocationInput("");
    setProductHints("");
  };

  // ── Render ────────────────────────────────────────────────────────────────
  return (
      <div className="p-6 max-w-5xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <Eye className="w-6 h-6 text-violet-600" />
              Visual Count
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Take a photo of a shelf and get a count of what's on it
            </p>
          </div>
          <div className="flex items-center gap-2">
            {modelsData?.available ? (
              <Badge variant="default" className="bg-emerald-600 gap-1">
                <Zap className="w-3 h-3" /> AI Online
              </Badge>
            ) : (
              <Badge variant="secondary" className="gap-1">
                <AlertCircle className="w-3 h-3" /> AI Offline
              </Badge>
            )}
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 border-b">
          {(["capture", "history"] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-4 py-2 text-sm font-medium capitalize transition-colors ${
                activeTab === tab
                  ? "border-b-2 border-violet-600 text-violet-600"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {tab === "capture" ? <><Camera className="w-4 h-4 inline mr-1" />Capture & Analyse</> : <><History className="w-4 h-4 inline mr-1" />History</>}
            </button>
          ))}
        </div>

        {activeTab === "capture" && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Left: Camera / Upload */}
            <div className="space-y-4">
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">Shelf Photo</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {/* Camera preview */}
                  <div className="relative bg-muted rounded-lg overflow-hidden aspect-video flex items-center justify-center">
                    <video ref={videoRef} className={`w-full h-full object-cover ${cameraActive ? "" : "hidden"}`} muted playsInline autoPlay />
                    {cameraActive ? null : capturedImage ? (
                      <img src={capturedImage} alt="Captured" loading="lazy" decoding="async" className="w-full h-full object-contain" />
                    ) : (
                      <div className="text-center text-muted-foreground">
                        <Camera className="w-12 h-12 mx-auto mb-2 opacity-40" />
                        <p className="text-sm">Take a photo or upload an image</p>
                      </div>
                    )}
                  </div>
                  <canvas ref={canvasRef} className="hidden" />

                  {/* Camera controls */}
                  <div className="flex gap-2">
                    {!cameraActive ? (
                      <Button variant="outline" size="sm" onClick={startCamera} className="flex-1 gap-1">
                        <Camera className="w-4 h-4" /> Open Camera
                      </Button>
                    ) : (
                      <>
                        <Button size="sm" onClick={capturePhoto} className="flex-1 gap-1 bg-violet-600 hover:bg-violet-700">
                          <Camera className="w-4 h-4" /> Capture
                        </Button>
                        <Button variant="outline" size="sm" onClick={stopCamera}>Cancel</Button>
                      </>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => fileInputRef.current?.click()}
                      className="flex-1 gap-1"
                    >
                      <Upload className="w-4 h-4" /> Upload
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => nativeCameraRef.current?.click()} className="flex-1 gap-1 sm:hidden">
                      <Camera className="w-4 h-4" /> Take photo
                    </Button>
                    {/* The phone's own camera app: works where a live camera in the browser doesn't. */}
                    <input ref={nativeCameraRef} type="file" accept="image/*" capture="environment" className="hidden" aria-label="Take a photo" onChange={handleFileUpload} />
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      className="hidden"
                      onChange={handleFileUpload}
                    />
                  </div>
                </CardContent>
              </Card>

              {/* Analysis config */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">Analysis Settings</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div>
                    <Label htmlFor="location">Location Name *</Label>
                    <Input
                      id="location"
                      placeholder="e.g. Warehouse A - Shelf 3"
                      value={locationName}
                      onChange={(e) => setLocationName(e.target.value)}
                    />
                  </div>
                  <div>
                    <Label htmlFor="hints">Product Hints</Label>
                    {/* Scan location field */}
                    <Input
                      className="mb-2 text-sm"
                      placeholder="Scan location (e.g. Shelf A3, Aisle 2, Store Front)"
                      value={scanLocationInput}
                      onChange={(e) => setScanLocationInput(e.target.value)}
                    />
                    {/* FMCG taxonomy autocomplete */}
                    <div className="relative">
                      <Input
                        id="hints-search"
                        placeholder="Type to search Nigerian FMCG products…"
                        value={hintsQuery}
                        onChange={(e) => { setHintsQuery(e.target.value); setShowHintsSuggestions(true); }}
                        onFocus={() => setShowHintsSuggestions(true)}
                        onBlur={() => setTimeout(() => setShowHintsSuggestions(false), 150)}
                        className="text-sm mb-1"
                      />
                      {showHintsSuggestions && hintsData?.hints && hintsData.hints.length > 0 && (
                        <div className="absolute z-50 w-full bg-popover border rounded-md shadow-md max-h-48 overflow-y-auto">
                          {hintsData.hints.map((h) => (
                            <button
                              key={h.id}
                              type="button"
                              className="w-full text-left px-3 py-2 text-sm hover:bg-accent flex items-center justify-between gap-2"
                              onMouseDown={() => {
                                const current = productHints.trim();
                                const newHint = h.label + (h.variants && h.variants.length > 0 ? ` (${h.variants.slice(0,2).join(", ")})` : "");
                                setProductHints(current ? current + ", " + newHint : newHint);
                                setHintsQuery("");
                                setShowHintsSuggestions(false);
                              }}
                            >
                              <span className="font-medium">{h.label}</span>
                              <span className="text-xs text-muted-foreground shrink-0">{h.brand} · {h.category}{h.isSachet ? " · sachet" : ""}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                    <Textarea
                      id="hints"
                      placeholder="e.g. Coca-Cola, Indomie Chicken, Dano Milk, Maggi cubes"
                      value={productHints}
                      onChange={(e) => setProductHints(e.target.value)}
                      rows={2}
                      className="text-sm"
                    />
                    <p className="text-xs text-muted-foreground mt-1">
                      Search Nigerian FMCG products above or type comma-separated hints. Helps the AI identify local brands accurately.
                    </p>
                  </div>
                  {modelsData?.models && modelsData.models.length > 0 && (
                    <div>
                      <Label htmlFor="model">VLM Model</Label>
                      <select
                        id="model"
                        value={vlmModel}
                        onChange={(e) => setVlmModel(e.target.value)}
                        className="w-full border rounded-md px-3 py-2 text-sm bg-background"
                      >
                        <option value="">Auto (best available)</option>
                        {modelsData.models.map((m) => (
                          <option key={m} value={m}>{m}</option>
                        ))}
                      </select>
                    </div>
                  )}
                  <div className="flex gap-2 pt-1">
                    <Button
                      onClick={runAnalysis}
                      disabled={isAnalysing || !capturedImage}
                      className="flex-1 gap-2 bg-violet-600 hover:bg-violet-700"
                    >
                      {isAnalysing ? (
                        <><RefreshCw className="w-4 h-4 animate-spin" /> Analysing…</>
                      ) : (
                        <><Cpu className="w-4 h-4" /> Run AI Analysis</>
                      )}
                    </Button>
                    {(capturedImage || analysisResult) && (
                      <Button variant="outline" onClick={reset}>Reset</Button>
                    )}
                  </div>
                  {isAnalysing && (
                    <div className="space-y-1">
                      <Progress value={progress} className="h-2" />
                      <p className="text-xs text-muted-foreground text-center">
                        Counting what's in the photo. This usually takes one to two minutes…
                      </p>
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>

            {/* Right: Results */}
            <div className="space-y-4">
              {analysisResult ? (
                <>
                  {/* Summary */}
                  <Card className="border-violet-200 bg-violet-50/50 dark:bg-violet-950/20">
                    <CardContent className="pt-4">
                      <div className="grid grid-cols-3 gap-4 text-center">
                        <div>
                          <p className="text-2xl font-bold text-violet-700">{analysisResult.itemsDetected}</p>
                          <p className="text-xs text-muted-foreground">Product Types</p>
                        </div>
                        <div>
                          <p className="text-2xl font-bold text-violet-700">{analysisResult.totalCount}</p>
                          <p className="text-xs text-muted-foreground">Total Items</p>
                        </div>
                        <div>
                          <p className={`text-2xl font-bold ${confidenceColor(analysisResult.confidenceScore)}`}>
                            {Math.round(analysisResult.confidenceScore * 100)}%
                          </p>
                          <p className="text-xs text-muted-foreground">Confidence</p>
                        </div>
                      </div>
                      <Separator className="my-3" />
                      <p className="text-xs text-muted-foreground">
                        <strong>Model:</strong> {analysisResult.vlmModelUsed} ·{" "}
                        <strong>Time:</strong> {(analysisResult.processingMs / 1000).toFixed(1)}s
                      </p>
                      {analysisResult.sceneDescription && (
                        <p className="text-xs mt-2 italic text-muted-foreground">
                          "{analysisResult.sceneDescription}"
                        </p>
                      )}
                    </CardContent>
                  </Card>

                  {/* Detected items */}
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-base flex items-center gap-2">
                        <Package className="w-4 h-4" /> Detected Items
                      </CardTitle>
                      {analysisResult.items.length > 0 && (
                        <Button size="sm" className="mt-2 w-full gap-1 bg-emerald-600 hover:bg-emerald-700" onClick={() => openApply(analysisResult.sessionId, analysisResult.items)}>
                          <ClipboardCheck className="w-4 h-4" /> Add to products &amp; inventory
                        </Button>
                      )}
                    </CardHeader>
                    <CardContent>
                      <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
                        {analysisResult.items.map((item, i) => (
                          <div
                            key={i}
                            className="flex items-center justify-between p-2 rounded-lg bg-muted/50"
                          >
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium truncate">{item.label}</p>
                              {item.location && (
                                <p className="text-xs text-muted-foreground">{item.location}</p>
                              )}
                            </div>
                            <div className="flex items-center gap-2 ml-2 shrink-0">
                              <Badge variant={confidenceBadge(item.confidence)} className="text-xs">
                                {Math.round(item.confidence * 100)}%
                              </Badge>
                              <span className="text-sm font-bold w-8 text-right">{item.count}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </CardContent>
                  </Card>

                  {/* Apply to inventory */}
                  <Card className="border-emerald-200">
                    <CardContent className="pt-4">
                      <div className="flex items-center gap-2 text-emerald-700">
                        <CheckCircle className="w-4 h-4" />
                        <p className="text-sm font-medium">
                          Session saved. Review in History to apply counts to inventory.
                        </p>
                      </div>
                    </CardContent>
                  </Card>
                </>
              ) : (
                <Card className="h-full min-h-64 flex items-center justify-center border-dashed">
                  <CardContent className="text-center text-muted-foreground py-12">
                    <Layers className="w-12 h-12 mx-auto mb-3 opacity-30" />
                    <p className="text-sm">Analysis results will appear here</p>
                    <p className="text-xs mt-1">
                      Counted by {modelsData?.models?.[0] ?? "the image model"}
                    </p>
                  </CardContent>
                </Card>
              )}
            </div>
          </div>
        )}

        {activeTab === "history" && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-foreground">Scan History</h3>
              <Button variant="ghost" size="sm" onClick={() => refetchSessions()} className="h-7 text-xs gap-1">
                <RefreshCw className="w-3 h-3" /> Refresh
              </Button>
            </div>
            {!sessions || sessions.length === 0 ? (
              <Card className="border-dashed">
                <CardContent className="text-center py-12 text-muted-foreground">
                  <History className="w-10 h-10 mx-auto mb-2 opacity-30" />
                  <p>No inventory sessions yet. Capture a shelf photo to get started.</p>
                </CardContent>
              </Card>
            ) : (
              sessions.map((s) => {
                const items = (s.detectedItems as Array<{ label: string; count: number; confidence: number; bbox?: number[] }>) ?? [];
                const updates = (s.inventoryUpdates as Array<{ productId: string; label: string; oldQty?: number; newQty: number }>) ?? [];
                const isExpanded = expandedSessionId === s.id;
                return (
                  <Card key={s.id} className="hover:shadow-sm transition-shadow">
                    <CardContent className="pt-4">
                      {/* Header row */}
                      <div className="flex items-start gap-3">
                        {/* Thumbnail with bounding box overlay */}
                        <div className="relative shrink-0">
                          {s.imageUrl ? (
                            <div className="relative w-20 h-20 rounded-lg overflow-hidden bg-muted cursor-pointer"
                              onClick={() => setSelectedSession(selectedSession === s.id ? null : s.id)}>
                              <img src={s.imageUrl} alt="Shelf scan" loading="lazy" decoding="async" className="w-full h-full object-cover" />
                              {/* Bounding box overlays (simplified — percentage-based) */}
                              {items.slice(0, 5).map((item, idx) => (
                                item.bbox && item.bbox.length === 4 ? (
                                  <div key={idx} className="absolute border border-emerald-400 rounded-sm pointer-events-none"
                                    style={{
                                      left: `${item.bbox[0]}%`,
                                      top: `${item.bbox[1]}%`,
                                      width: `${item.bbox[2]}%`,
                                      height: `${item.bbox[3]}%`,
                                    }}
                                  />
                                ) : null
                              ))}
                              <div className="absolute inset-0 flex items-center justify-center bg-black/20 opacity-0 hover:opacity-100 transition-opacity">
                                <Eye className="w-4 h-4 text-foreground" />
                              </div>
                            </div>
                          ) : (
                            <div className="w-20 h-20 rounded-lg bg-muted flex items-center justify-center">
                              <ImageIcon className="w-6 h-6 text-muted-foreground opacity-40" />
                            </div>
                          )}
                        </div>
                        {/* Info */}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <Badge
                              variant={s.status === "completed" ? "default" : s.status === "failed" ? "destructive" : "secondary"}
                              className="text-xs"
                            >
                              {s.status}
                            </Badge>
                            {s.appliedToInventory && (
                              <Badge variant="outline" className="text-xs bg-emerald-50 text-emerald-700 border-emerald-200">
                                <ClipboardCheck className="w-3 h-3 mr-1" /> Applied
                              </Badge>
                            )}
                            <span className="text-xs text-muted-foreground">
                              {new Date(s.createdAt).toLocaleString()}
                            </span>
                          </div>
                          <p className="text-sm font-medium mt-1">
                            {s.totalItemsDetected ?? 0} items detected
                            {s.modelUsed && <span className="text-xs text-muted-foreground ml-2">via {s.modelUsed}</span>}
                          </p>
                          {s.vlmAnalysis && (
                            <p className="text-xs text-muted-foreground mt-1 line-clamp-2 italic">
                              "{s.vlmAnalysis}"
                            </p>
                          )}
                          <div className="flex gap-2 mt-2">
                            <Button variant="ghost" size="sm" className="h-6 text-xs gap-1 px-2"
                              onClick={() => setExpandedSessionId(isExpanded ? null : s.id)}>
                              {isExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                              {isExpanded ? "Hide" : "Details"}
                            </Button>
                            {!s.appliedToInventory && s.status === "completed" && items.length > 0 && (
                              <Button size="sm" className="h-6 text-xs gap-1 px-2 bg-emerald-600 hover:bg-emerald-700"
                                onClick={() => {
                                  openApply(s.id, items);
                                  setApplyDialogOpen(true);
                                }}>
                                <ClipboardCheck className="w-3 h-3" /> Add to products &amp; inventory
                              </Button>
                            )}
                            {s.appliedToInventory && updates.length > 0 && (
                              <Button variant="ghost" size="sm" className="h-6 text-xs gap-1 px-2"
                                onClick={() => setExpandedSessionId(isExpanded ? null : s.id)}>
                                <Package className="w-3 h-3" /> {updates.length} updates
                              </Button>
                            )}
                          </div>
                        </div>
                      </div>
                      {/* Expanded details: detected items table + inventory updates */}
                      {isExpanded && (
                        <div className="mt-3 pt-3 border-t border-border space-y-3">
                          {items.length > 0 && (
                            <div>
                              <p className="text-xs font-semibold text-muted-foreground mb-2">Detected Items</p>
                              <div className="space-y-1">
                                {items.map((item, idx) => (
                                  <div key={idx} className="flex items-center justify-between text-xs bg-muted/40 rounded px-2 py-1 gap-2">
                                    <span className="font-medium flex-1 truncate">{item.label}</span>
                                    <div className="flex items-center gap-2 shrink-0">
                                      {inlineEditing?.sessionId === s.id && inlineEditing?.label === item.label ? (
                                        <div className="flex items-center gap-1">
                                          <button className="w-5 h-5 rounded bg-muted hover:bg-muted/80 flex items-center justify-center font-bold"
                                            onClick={() => setInlineEditValue(v => Math.max(0, v - 1))}>−</button>
                                          <span className="w-8 text-center font-mono font-semibold">{inlineEditValue}</span>
                                          <button className="w-5 h-5 rounded bg-muted hover:bg-muted/80 flex items-center justify-center font-bold"
                                            onClick={() => setInlineEditValue(v => v + 1)}>+</button>
                                          <button className="px-2 py-0.5 rounded bg-emerald-600 text-white text-xs font-medium hover:bg-emerald-700"
                                            onClick={() => addCorrectionMutation.mutate({
                                              sessionId: s.id,
                                              detectedLabel: item.label,
                                              originalCount: item.count,
                                              correctedCount: inlineEditValue,
                                            })}>
                                            ✓
                                          </button>
                                          <button className="px-1.5 py-0.5 rounded bg-muted text-xs hover:bg-muted/80"
                                            onClick={() => setInlineEditing(null)}>✕</button>
                                        </div>
                                      ) : (
                                        <>
                                          <span className="text-muted-foreground">×{item.count}</span>
                                          <span className={confidenceColor(item.confidence)}>
                                            {(item.confidence * 100).toFixed(0)}%
                                          </span>
                                          <button
                                            className="px-1.5 py-0.5 rounded text-xs bg-amber-100 text-amber-700 hover:bg-amber-200 dark:bg-amber-900/30 dark:text-amber-400"
                                            title="Correct this count"
                                            onClick={() => {
                                              setInlineEditing({ sessionId: s.id, label: item.label, count: item.count });
                                              setInlineEditValue(item.count);
                                            }}>
                                            ✏ Correct
                                          </button>
                                        </>
                                      )}
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                          {updates.length > 0 && (
                            <div>
                              <p className="text-xs font-semibold text-muted-foreground mb-2">Inventory Updates Applied</p>
                              <div className="space-y-1">
                                {updates.map((u, idx) => (
                                  <div key={idx} className="flex items-center justify-between text-xs bg-emerald-50 dark:bg-emerald-950/30 rounded px-2 py-1">
                                    <span className="font-medium">{u.label ?? u.productId}</span>
                                    <span className="text-emerald-700 dark:text-emerald-400">
                                      {u.oldQty !== undefined ? `${u.oldQty} → ` : ""}{u.newQty}
                                    </span>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                          {s.processingMs && (
                            <p className="text-xs text-muted-foreground">Processing time: {s.processingMs}ms</p>
                          )}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                );
              })
            )}
          </div>
        )}
        {/* Add to products and inventory */}
        <Dialog open={applyDialogOpen} onOpenChange={setApplyDialogOpen}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>Add to products and inventory</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground">Check each count. Match items to products you already sell, or add them as new products. Stock is set to the number you confirm.</p>
            <ScrollArea className="max-h-[55vh]">
              <div className="space-y-3 pr-2">
                {applyAdjustments.map((adj, idx) => {
                  const set = (patch: Partial<ApplyRow>) => setApplyAdjustments((prev) => prev.map((a, i) => (i === idx ? { ...a, ...patch } : a)));
                  return (
                    <div key={idx} className={`space-y-2 rounded border border-border p-2.5 ${adj.include ? "" : "opacity-50"}`}>
                      <div className="flex items-center gap-2">
                        <input type="checkbox" checked={adj.include} onChange={(e) => set({ include: e.target.checked })} aria-label={`Include ${adj.detectedLabel}`} />
                        <span className="flex-1 truncate text-sm font-medium">{adj.detectedLabel}</span>
                        <Button variant="outline" size="sm" className="h-7 w-7 p-0" aria-label="Fewer" onClick={() => set({ confirmedCount: Math.max(0, adj.confirmedCount - 1) })}>−</Button>
                        <Input type="number" min={0} inputMode="numeric" value={adj.confirmedCount} onChange={(e) => set({ confirmedCount: Math.max(0, parseInt(e.target.value) || 0) })} className="h-7 w-14 text-center font-mono" aria-label={`Count of ${adj.detectedLabel}`} />
                        <Button variant="outline" size="sm" className="h-7 w-7 p-0" aria-label="More" onClick={() => set({ confirmedCount: adj.confirmedCount + 1 })}>+</Button>
                      </div>
                      {adj.include && (
                        <>
                          <select className="w-full rounded border border-input bg-background px-2 py-1.5 text-sm" value={adj.target} onChange={(e) => set({ target: e.target.value })} aria-label={`Product for ${adj.detectedLabel}`}>
                            <option value="new">+ Add as a new product</option>
                            {(catalog ?? []).map((p) => <option key={p.id} value={p.id}>Update: {p.name} (now {p.stockQuantity})</option>)}
                          </select>
                          {adj.target === "new" && (
                            <div className="grid grid-cols-[1fr_7rem] gap-2">
                              <Input value={adj.newName} onChange={(e) => set({ newName: e.target.value })} placeholder="Product name" aria-label="New product name" />
                              <Input value={adj.newPrice} inputMode="decimal" onChange={(e) => set({ newPrice: e.target.value.replace(/[^\d.]/g, "") })} placeholder="Price (₦)" aria-label="New product price" />
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            </ScrollArea>
            {(() => {
              const chosen = applyAdjustments.filter((a) => a.include);
              const missing = chosen.filter((a) => a.target === "new" && (!a.newName.trim() || !/^\d+(\.\d{1,2})?$/.test(a.newPrice)));
              return (
                <DialogFooter className="items-center gap-2">
                  {missing.length > 0 && <p className="mr-auto text-xs text-destructive" role="alert">Give each new product a name and price.</p>}
                  <Button variant="ghost" onClick={() => setApplyDialogOpen(false)}>Cancel</Button>
                  <Button
                    className="bg-emerald-600 hover:bg-emerald-700"
                    disabled={applyMutation.isPending || !selectedSession || chosen.length === 0 || missing.length > 0}
                    onClick={() => {
                      if (!selectedSession) return;
                      applyMutation.mutate({
                        sessionId: selectedSession,
                        adjustments: chosen.map((a) => a.target === "new"
                          ? { detectedLabel: a.detectedLabel, confirmedCount: a.confirmedCount, create: { name: a.newName.trim(), price: a.newPrice } }
                          : { detectedLabel: a.detectedLabel, confirmedCount: a.confirmedCount, productId: a.target }),
                      });
                    }}
                  >
                    {applyMutation.isPending ? "Saving…" : `Save ${chosen.length} item${chosen.length === 1 ? "" : "s"}`}
                  </Button>
                </DialogFooter>
              );
            })()}
          </DialogContent>
        </Dialog>

      </div>
  );
}
