import { useState, useRef, useCallback } from "react";
import { trpc } from "@/lib/trpc";
import DashboardLayout from "@/components/DashboardLayout";
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
} from "lucide-react";
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
export default function VisualInventory() {
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
  const [cameraActive, setCameraActive] = useState(false);

  const analyseMutation = trpc.visualInventory.analyseImage.useMutation();
  const { data: sessions, refetch: refetchSessions } = trpc.visualInventory.listSessions.useQuery({ limit: 20 });
  const { data: modelsData } = trpc.visualInventory.getOllamaModels.useQuery();

  // ── Camera ────────────────────────────────────────────────────────────────
  const startCamera = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1080 } },
      });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.play();
        setCameraActive(true);
      }
    } catch (err) {
      toast.error("Camera access denied. Please allow camera permissions.");
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
    setCapturedImage(dataUrl);
    setCapturedMime("image/jpeg");
    stopCamera();
    toast.success("Photo captured!");
  }, [stopCamera]);

  // ── File Upload ───────────────────────────────────────────────────────────
  const handleFileUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const result = ev.target?.result as string;
      setCapturedImage(result);
      setCapturedMime(file.type as "image/jpeg" | "image/png" | "image/webp");
    };
    reader.readAsDataURL(file);
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

      const result = await analyseMutation.mutateAsync({
        imageBase64: base64,
        mimeType: capturedMime,
        locationName: locationName.trim(),
        notes: "",
        productHints: hints,
        vlmModel: vlmModel || undefined,
      });

      setProgress(100);
      setAnalysisResult(result as AnalysisResult);
      refetchSessions();
      toast.success(`Analysis complete! Detected ${result.itemsDetected} product types.`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Analysis failed";
      toast.error(msg.includes("orchestrator") ? "AI service unavailable — start the visual inventory stack." : msg);
    } finally {
      clearInterval(progressInterval);
      setIsAnalysing(false);
    }
  }, [capturedImage, capturedMime, locationName, productHints, vlmModel, analyseMutation, refetchSessions]);

  const reset = () => {
    setCapturedImage(null);
    setAnalysisResult(null);
    setProgress(0);
    setLocationName("");
    setProductHints("");
  };

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <DashboardLayout>
      <div className="p-6 max-w-5xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <Eye className="w-6 h-6 text-violet-600" />
              Visual Inventory
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              AI-powered inventory counting using Ollama VLM + YOLO11 object detection
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
                    {cameraActive ? (
                      <video ref={videoRef} className="w-full h-full object-cover" muted playsInline />
                    ) : capturedImage ? (
                      <img src={capturedImage} alt="Captured" className="w-full h-full object-contain" />
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
                    <Label htmlFor="hints">Product Hints (comma-separated)</Label>
                    <Textarea
                      id="hints"
                      placeholder="e.g. Coca-Cola, Pepsi, water bottles, Indomie noodles"
                      value={productHints}
                      onChange={(e) => setProductHints(e.target.value)}
                      rows={2}
                      className="text-sm"
                    />
                    <p className="text-xs text-muted-foreground mt-1">
                      Helps the AI match detected items to your known products
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
                        Running YOLO detection + Ollama VLM analysis…
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
                      Powered by YOLO11 + Ollama ({modelsData?.models?.[0] ?? "Qwen2.5-VL / MiniCPM-V / Gemma3"})
                    </p>
                  </CardContent>
                </Card>
              )}
            </div>
          </div>
        )}

        {activeTab === "history" && (
          <div className="space-y-3">
            {!sessions || sessions.length === 0 ? (
              <Card className="border-dashed">
                <CardContent className="text-center py-12 text-muted-foreground">
                  <History className="w-10 h-10 mx-auto mb-2 opacity-30" />
                  <p>No inventory sessions yet. Capture a shelf photo to get started.</p>
                </CardContent>
              </Card>
            ) : (
              sessions.map((s) => (
                <Card key={s.id} className="hover:shadow-sm transition-shadow">
                  <CardContent className="pt-4">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <Badge
                            variant={s.status === "completed" ? "default" : s.status === "failed" ? "destructive" : "secondary"}
                            className="text-xs"
                          >
                            {s.status}
                          </Badge>
                          <span className="text-xs text-muted-foreground">
                            {new Date(s.createdAt).toLocaleString()}
                          </span>
                        </div>
                        <p className="text-sm font-medium mt-1">
                          {s.totalItemsDetected ?? 0} items detected
                        </p>
                        {s.vlmAnalysis && (
                          <p className="text-xs text-muted-foreground mt-1 line-clamp-2 italic">
                            "{s.vlmAnalysis}"
                          </p>
                        )}
                        {s.modelUsed && (
                          <p className="text-xs text-muted-foreground mt-1">
                            Model: {s.modelUsed} · {s.processingMs ?? 0}ms
                          </p>
                        )}
                      </div>
                      {s.imageUrl && (
                        <img
                          src={s.imageUrl}
                          alt="Shelf"
                          className="w-16 h-16 object-cover rounded-lg shrink-0"
                        />
                      )}
                    </div>
                  </CardContent>
                </Card>
              ))
            )}
          </div>
        )}

        {/* Architecture info */}
        <Card className="bg-muted/30 border-dashed">
          <CardContent className="pt-4">
            <p className="text-xs text-muted-foreground font-medium mb-2">AI Stack Architecture</p>
            <div className="flex flex-wrap gap-2">
              {[
                { lang: "Go", role: "Image preprocessing + rate limiting", color: "bg-cyan-100 text-cyan-800 dark:bg-cyan-900 dark:text-cyan-200" },
                { lang: "Python", role: "YOLO11 detection + Ollama VLM", color: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200" },
                { lang: "Rust", role: "BBox NMS + confidence scoring", color: "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200" },
                { lang: "TypeScript", role: "tRPC API + DB + frontend", color: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200" },
              ].map((s) => (
                <span key={s.lang} className={`text-xs px-2 py-1 rounded-full font-medium ${s.color}`}>
                  {s.lang}: {s.role}
                </span>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
