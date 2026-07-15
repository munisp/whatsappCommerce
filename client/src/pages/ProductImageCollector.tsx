import { useState, useRef, useCallback, useEffect, DragEvent } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { toast } from "sonner";
import {
  Camera, Upload, Star, Trash2, CheckCircle2, AlertCircle,
  BarChart3, Download, RefreshCw, Images, Filter, Layers,
  Play, Square, Terminal, Zap,
  History, FileArchive, Sparkles
} from "lucide-react";

// ── Fine-tune log streaming hook ──────────────────────────────────────────────
function useFineTuneStream() {
  const [logs, setLogs] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  const start = useCallback((dryRun = true) => {
    if (esRef.current) { esRef.current.close(); esRef.current = null; }
    setLogs([]);
    setDone(false);
    setRunning(true);
    const es = new EventSource(`/api/finetune/stream?dryRun=${dryRun}`);
    esRef.current = es;

    const handler = (e: MessageEvent) => {
      try {
        const payload = JSON.parse(e.data) as { message: string };
        setLogs(prev => [...prev, payload.message]);
      } catch { /* ignore */ }
    };

    es.addEventListener("log", handler);
    es.addEventListener("status", handler);
    es.addEventListener("error", (e: MessageEvent) => {
      try {
        const payload = JSON.parse(e.data) as { message: string };
        setLogs(prev => [...prev, `ERROR: ${payload.message}`]);
      } catch { /* ignore */ }
      setRunning(false);
      setDone(true);
      es.close();
    });
    es.addEventListener("done", (e: MessageEvent) => {
      try {
        const payload = JSON.parse(e.data) as { message: string };
        setLogs(prev => [...prev, `✓ ${payload.message}`]);
      } catch { /* ignore */ }
      setRunning(false);
      setDone(true);
      es.close();
    });

    es.onerror = () => {
      setLogs(prev => [...prev, "[connection closed]"]);
      setRunning(false);
      setDone(true);
      es.close();
    };
  }, []);

  const stop = useCallback(() => {
    esRef.current?.close();
    esRef.current = null;
    setRunning(false);
    setDone(true);
    setLogs(prev => [...prev, "[cancelled by user]"]);
  }, []);

  useEffect(() => () => { esRef.current?.close(); }, []);

  return { logs, running, done, start, stop };
}

export default function ProductImageCollector() {
  const [selectedClass, setSelectedClass] = useState<string>("");
  const [capturedImage, setCapturedImage] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [qualityScore, setQualityScore] = useState<number>(3);
  const [source, setSource] = useState<"camera" | "upload">("upload");
  const [viewClass, setViewClass] = useState<string | null>(null);
  const [targetCount, setTargetCount] = useState<number>(20);
  const [filterNeedingImages, setFilterNeedingImages] = useState(false);
  const [isDraggingBatch, setIsDraggingBatch] = useState(false);
  const [showFineTune, setShowFineTune] = useState(false);
  const [dryRun, setDryRun] = useState(true);
  const [showRunHistory, setShowRunHistory] = useState(false);

  // Batch upload state
  const [batchClass, setBatchClass] = useState<string>("");
  const [batchFiles, setBatchFiles] = useState<File[]>([]);
  const [batchProgress, setBatchProgress] = useState<{ current: number; total: number } | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const batchInputRef = useRef<HTMLInputElement>(null);
  const logScrollRef = useRef<HTMLDivElement>(null);

  const ftStream = useFineTuneStream();

  // Auto-scroll log to bottom
  useEffect(() => {
    if (logScrollRef.current) {
      logScrollRef.current.scrollTop = logScrollRef.current.scrollHeight;
    }
  }, [ftStream.logs]);

  const { data: classes, refetch: refetchClasses } = trpc.productImages.listClasses.useQuery();
  const { data: classImages, refetch: refetchClassImages } = trpc.productImages.listByClass.useQuery(
    { className: viewClass! },
    { enabled: !!viewClass }
  );
  const { data: stats, refetch: refetchStats } = trpc.productImages.datasetStats.useQuery();

  const uploadMutation = trpc.productImages.uploadImage.useMutation({
    onSuccess: () => {
      toast.success("Image uploaded successfully");
      setCapturedImage(null);
      setNotes("");
      setQualityScore(3);
      refetchClasses();
      refetchStats();
      if (viewClass) refetchClassImages();
    },
    onError: (err) => toast.error(err.message),
  });

  const deleteMutation = trpc.productImages.deleteImage.useMutation({
    onSuccess: () => {
      toast.success("Image deleted");
      refetchClasses();
      refetchStats();
      if (viewClass) refetchClassImages();
    },
  });

  const rateMutation = trpc.productImages.rateImage.useMutation({
    onSuccess: () => { if (viewClass) refetchClassImages(); },
  });

  const exportMutation = trpc.productImages.exportManifest.useMutation({
    onSuccess: (data) => {
      const blob = new Blob([JSON.stringify(data.manifest, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `fmcg-dataset-manifest-${Date.now()}.json`;
      a.click();
      toast.success(`Exported ${data.totalImages} images across ${data.classCount} classes`);
      refetchClasses();
      refetchStats();
    },
  });

  const batchUploadMutation = trpc.productImages.batchUpload.useMutation({
    onSuccess: (data) => {
      setBatchProgress(null);
      setBatchFiles([]);
      setBatchClass("");
      refetchClasses();
      refetchStats();
      if (viewClass) refetchClassImages();
      if (data.failed > 0) {
        toast.warning(`Uploaded ${data.uploaded} images, ${data.failed} failed`);
      } else {
        toast.success(`Batch upload complete: ${data.uploaded} images added`);
      }
    },
    onError: (err) => {
      setBatchProgress(null);
      toast.error(err.message);
    },
  });

  const handleFileSelect = useCallback((file: File, src: "camera" | "upload") => {
    const reader = new FileReader();
    reader.onload = (e) => {
      setCapturedImage(e.target?.result as string);
      setSource(src);
    };
    reader.readAsDataURL(file);
  }, []);

  const handleUpload = () => {
    if (!capturedImage || !selectedClass) {
      toast.error("Please select a product class and capture/upload an image");
      return;
    }
    uploadMutation.mutate({
      className: selectedClass,
      imageBase64: capturedImage,
      source,
      notes: notes || undefined,
      qualityScore,
    });
  };

  const handleBatchFileSelect = (files: FileList | File[]) => {
    const fileArray = Array.from(files).filter(f => f.type.startsWith("image/"));
    if (fileArray.length === 0) { toast.error("No valid image files selected"); return; }
    if (fileArray.length > 50) { toast.error("Maximum 50 files per batch"); return; }
    setBatchFiles(fileArray);
  };

  // Drag-and-drop handlers for batch zone
  const handleBatchDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingBatch(true);
  };

  const handleBatchDragLeave = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingBatch(false);
  };

  const handleBatchDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingBatch(false);
    const files = e.dataTransfer.files;
    if (files && files.length > 0) handleBatchFileSelect(files);
  };

  const handleBatchUpload = async () => {
    if (!batchClass || batchFiles.length === 0) {
      toast.error("Please select a class and at least one image file");
      return;
    }
    setBatchProgress({ current: 0, total: batchFiles.length });
    const images: { imageBase64: string; source: "upload" }[] = [];
    for (let i = 0; i < batchFiles.length; i++) {
      setBatchProgress({ current: i + 1, total: batchFiles.length });
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target?.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(batchFiles[i]);
      });
      images.push({ imageBase64: base64, source: "upload" });
    }
    batchUploadMutation.mutate({ className: batchClass, images });
  };

  const readyClasses = classes?.filter(c => c.totalImages >= targetCount).length ?? 0;
  const { data: runHistory, refetch: refetchRunHistory } = trpc.fineTune.listRuns.useQuery(
    { limit: 20 },
    { enabled: showRunHistory }
  );
  // Quality-gated: classes where qualityImages (score ≥ 3) meets target
  const qualityReadyClasses = classes?.filter(c => (c.qualityImages ?? 0) >= targetCount).length ?? 0;
  const totalClasses = classes?.length ?? 30;
  const displayedClasses = filterNeedingImages
    ? (classes?.filter(c => c.totalImages < targetCount) ?? [])
    : (classes ?? []);

  const getProgressColor = (count: number) => {
    if (count >= targetCount) return "bg-green-500";
    if (count >= Math.ceil(targetCount / 2)) return "bg-yellow-500";
    return "bg-red-500";
  };

  const getProgressBadge = (c: { totalImages: number; qualityImages?: number }) => {
    const qualityGated = c.qualityImages ?? 0;
    if (c.totalImages >= targetCount && qualityGated >= targetCount) {
      return <Badge className="text-xs bg-green-500/10 text-green-700 border-green-200">Ready ✓</Badge>;
    }
    if (c.totalImages >= targetCount && qualityGated < targetCount) {
      return <Badge className="text-xs bg-amber-500/10 text-amber-700 border-amber-200">Low Quality</Badge>;
    }
    if (c.totalImages >= Math.ceil(targetCount / 2)) {
      return <Badge className="text-xs bg-yellow-500/10 text-yellow-700 border-yellow-200">Partial</Badge>;
    }
    return <Badge variant="outline" className="text-xs text-red-600 border-red-200">Need more</Badge>;
  };

  return (
    <DashboardLayout>
      <div className="p-6 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-2xl font-bold text-foreground">Product Image Collector</h1>
            <p className="text-muted-foreground mt-1">Collect product photos for YOLO training — Nigerian FMCG classes</p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <div className="flex items-center gap-2">
              <label className="text-sm text-muted-foreground whitespace-nowrap">Target per class:</label>
              <Input
                type="number"
                min={1}
                max={100}
                value={targetCount}
                onChange={e => setTargetCount(Math.max(1, parseInt(e.target.value) || 20))}
                className="w-20 h-8 text-sm"
              />
            </div>
            <Button
              onClick={() => setShowFineTune(!showFineTune)}
              variant={showFineTune ? "default" : "outline"}
              className="gap-2"
            >
              <Zap className="w-4 h-4" />
              Fine-Tune Run
            </Button>
            <Button
              onClick={() => exportMutation.mutate()}
              disabled={exportMutation.isPending}
              variant="outline"
              className="gap-2"
            >
              <Download className="w-4 h-4" />
              {exportMutation.isPending ? "Exporting..." : "Export Manifest"}
            </Button>
            <Button
              onClick={() => {
                const a = document.createElement("a");
                a.href = "/api/finetune/export-yolo";
                a.download = `yolo-labels-${Date.now()}.zip`;
                a.click();
              }}
              variant="outline"
              className="gap-2"
            >
              <FileArchive className="w-4 h-4" />
              Export YOLO Labels
            </Button>
            <Button
              onClick={() => { setShowRunHistory(!showRunHistory); if (!showRunHistory) refetchRunHistory(); }}
              variant={showRunHistory ? "default" : "outline"}
              className="gap-2"
            >
              <History className="w-4 h-4" />
              Run History
            </Button>
          </div>
        </div>

        {/* Dataset Stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[
            { label: "Total Images", value: stats?.totalImages ?? 0, icon: <BarChart3 className="w-5 h-5 text-blue-500" /> },
            { label: "Classes with Images", value: stats?.classesWithImages ?? 0, icon: <Layers className="w-5 h-5 text-purple-500" /> },
            { label: `At Target (≥${targetCount})`, value: `${readyClasses}/${totalClasses}`, icon: <CheckCircle2 className="w-5 h-5 text-green-500" /> },
            { label: `Quality Ready (≥3★, ≥${targetCount})`, value: `${qualityReadyClasses}/${totalClasses}`, icon: <Star className="w-5 h-5 text-amber-500" /> },
          ].map((s) => (
            <Card key={s.label}>
              <CardContent className="pt-4 pb-3">
                <div className="flex items-center gap-3">
                  {s.icon}
                  <div>
                    <p className="text-xs text-muted-foreground">{s.label}</p>
                    <p className="text-xl font-bold">{s.value}</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Fine-Tune Run Panel */}
        {showFineTune && (
          <Card className="border-primary/30">
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center justify-between">
                <span className="flex items-center gap-2">
                  <Terminal className="w-4 h-4 text-primary" />
                  Fine-Tune Pipeline
                </span>
                <div className="flex items-center gap-3">
                  <label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer">
                    <input
                      type="checkbox"
                      checked={dryRun}
                      onChange={e => setDryRun(e.target.checked)}
                      className="rounded"
                    />
                    Dry run (no GPU)
                  </label>
                  {ftStream.running ? (
                    <Button size="sm" variant="destructive" className="gap-2 h-7" onClick={ftStream.stop}>
                      <Square className="w-3 h-3" />
                      Stop
                    </Button>
                  ) : (
                    <Button size="sm" className="gap-2 h-7" onClick={() => ftStream.start(dryRun)}>
                      <Play className="w-3 h-3" />
                      {ftStream.done ? "Re-run" : "Start Fine-Tune Run"}
                    </Button>
                  )}
                </div>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div
                ref={logScrollRef}
                className="bg-zinc-950 text-green-400 font-mono text-xs rounded-lg p-3 h-52 overflow-y-auto"
              >
                {ftStream.logs.length === 0 ? (
                  <span className="text-zinc-500">
                    {ftStream.running ? "Connecting..." : "Press Start Fine-Tune Run to begin. Enable Dry run to test without a GPU."}
                  </span>
                ) : (
                  ftStream.logs.map((line, i) => (
                    <div key={i} className={`leading-5 ${line.startsWith("ERROR") ? "text-red-400" : line.startsWith("✓") ? "text-cyan-400" : ""}`}>
                      {line}
                    </div>
                  ))
                )}
                {ftStream.running && (
                  <span className="inline-block w-2 h-4 bg-green-400 animate-pulse ml-0.5" />
                )}
              </div>
            {ftStream.done && ftStream.logs.length > 0 && (
              <p className="text-xs text-muted-foreground mt-2">
                Run complete. {dryRun ? "This was a dry run — no model weights were modified." : "Check your GPU server for the saved model checkpoint."}
              </p>
            )}
          </CardContent>
        </Card>
        )}
        {/* Run History Panel */}
        {showRunHistory && (
          <Card className="border-muted">
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <History className="w-4 h-4 text-muted-foreground" />
                Fine-Tune Run History
              </CardTitle>
            </CardHeader>
            <CardContent>
              {!runHistory || runHistory.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-6">No runs recorded yet. Start a fine-tune run above to see history here.</p>
              ) : (
                <div className="space-y-2">
                  {runHistory.map((run) => (
                    <div key={run.id} className="flex items-center justify-between rounded-lg border px-4 py-2.5 text-sm">
                      <div className="flex items-center gap-3">
                        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${
                          run.status === "completed" ? "bg-green-500" :
                          run.status === "failed" ? "bg-red-500" :
                          run.status === "cancelled" ? "bg-amber-500" : "bg-blue-500 animate-pulse"
                        }`} />
                        <div>
                          <span className="font-medium capitalize">{run.status}</span>
                          {run.dryRun && <span className="ml-2 text-xs text-muted-foreground">(dry run)</span>}
                        </div>
                      </div>
                      <div className="flex items-center gap-4 text-muted-foreground text-xs">
                        <span>{new Date(run.startedAt).toLocaleString()}</span>
                        {run.endedAt && (
                          <span>{Math.round((new Date(run.endedAt).getTime() - new Date(run.startedAt).getTime()) / 1000)}s</span>
                        )}
                        {run.exitCode != null && (
                          <span className={run.exitCode === 0 ? "text-green-600" : "text-red-500"}>
                            exit {run.exitCode}
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Single Upload Panel */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Camera className="w-4 h-4" />
                Single Image Upload
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <label className="text-sm font-medium mb-1 block">Product Class</label>
                <Select value={selectedClass} onValueChange={setSelectedClass}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select a product class..." />
                  </SelectTrigger>
                  <SelectContent>
                    {classes?.map(c => (
                      <SelectItem key={c.className} value={c.className}>
                        <span className="flex items-center gap-2">
                          {c.displayName}
                          <span className="text-xs text-muted-foreground">({c.totalImages} imgs)</span>
                          {c.totalImages >= targetCount && <CheckCircle2 className="w-3 h-3 text-green-500" />}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {capturedImage ? (
                <div className="relative">
                  <img src={capturedImage} alt="Preview" className="w-full h-48 object-contain rounded-lg border bg-muted" />
                  <Button
                    size="sm"
                    variant="destructive"
                    className="absolute top-2 right-2"
                    onClick={() => setCapturedImage(null)}
                  >
                    <Trash2 className="w-3 h-3" />
                  </Button>
                </div>
              ) : (
                <div className="h-48 border-2 border-dashed rounded-lg flex flex-col items-center justify-center gap-3 bg-muted/30">
                  <p className="text-sm text-muted-foreground">Capture or upload a product photo</p>
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" className="gap-2" onClick={() => cameraInputRef.current?.click()}>
                      <Camera className="w-4 h-4" />Camera
                    </Button>
                    <Button variant="outline" size="sm" className="gap-2" onClick={() => fileInputRef.current?.click()}>
                      <Upload className="w-4 h-4" />Upload File
                    </Button>
                  </div>
                </div>
              )}

              <div>
                <label className="text-sm font-medium mb-1 block">Image Quality</label>
                <div className="flex gap-1">
                  {[1, 2, 3, 4, 5].map(n => (
                    <button key={n} onClick={() => setQualityScore(n)}
                      className={`p-1 transition-colors ${n <= qualityScore ? "text-yellow-400" : "text-muted-foreground/30"}`}>
                      <Star className="w-5 h-5 fill-current" />
                    </button>
                  ))}
                  <span className="ml-2 text-xs text-muted-foreground self-center">
                    {["", "Poor", "Fair", "Good", "Great", "Perfect"][qualityScore]}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground mt-1">Images rated ≥3★ count toward the quality gate</p>
              </div>

              <div>
                <label className="text-sm font-medium mb-1 block">Notes (optional)</label>
                <Textarea placeholder="e.g. 70g pack, white background, good lighting" value={notes}
                  onChange={e => setNotes(e.target.value)} rows={2} />
              </div>

              <Button className="w-full" onClick={handleUpload}
                disabled={!capturedImage || !selectedClass || uploadMutation.isPending}>
                {uploadMutation.isPending ? "Uploading..." : "Upload to Dataset"}
              </Button>
            </CardContent>
          </Card>

          {/* Batch Upload Panel */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Images className="w-4 h-4" />
                Batch Upload (up to 50 files)
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <label className="text-sm font-medium mb-1 block">Product Class</label>
                <Select value={batchClass} onValueChange={setBatchClass}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select a product class..." />
                  </SelectTrigger>
                  <SelectContent>
                    {classes?.map(c => (
                      <SelectItem key={c.className} value={c.className}>
                        <span className="flex items-center gap-2">
                          {c.displayName}
                          <span className="text-xs text-muted-foreground">({c.totalImages} imgs)</span>
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Drop zone with drag-and-drop */}
              <div
                className={`h-36 border-2 border-dashed rounded-lg flex flex-col items-center justify-center gap-2 transition-colors cursor-pointer ${
                  isDraggingBatch
                    ? "border-primary bg-primary/10"
                    : "bg-muted/30 hover:bg-muted/50"
                }`}
                onClick={() => batchInputRef.current?.click()}
                onDragOver={handleBatchDragOver}
                onDragLeave={handleBatchDragLeave}
                onDrop={handleBatchDrop}
              >
                {batchFiles.length > 0 ? (
                  <>
                    <Images className="w-8 h-8 text-primary" />
                    <p className="text-sm font-medium">{batchFiles.length} file{batchFiles.length !== 1 ? "s" : ""} selected</p>
                    <p className="text-xs text-muted-foreground">Click or drop to change selection</p>
                  </>
                ) : (
                  <>
                    <Upload className={`w-8 h-8 ${isDraggingBatch ? "text-primary" : "text-muted-foreground"}`} />
                    <p className="text-sm text-muted-foreground">
                      {isDraggingBatch ? "Drop images here" : "Click or drag & drop images here"}
                    </p>
                    <p className="text-xs text-muted-foreground">JPG, PNG — up to 50 files</p>
                  </>
                )}
              </div>

              {batchProgress && (
                <div className="space-y-1">
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>Preparing images...</span>
                    <span>{batchProgress.current}/{batchProgress.total}</span>
                  </div>
                  <Progress value={(batchProgress.current / batchProgress.total) * 100} className="h-2" />
                </div>
              )}
              {batchFiles.length > 0 && !batchProgress && (
                <div className="text-xs text-muted-foreground bg-muted/50 rounded p-2 space-y-0.5">
                  {batchFiles.slice(0, 5).map((f, i) => (
                    <div key={i} className="truncate">• {f.name}</div>
                  ))}
                  {batchFiles.length > 5 && <div>...and {batchFiles.length - 5} more</div>}
                </div>
              )}
              <Button className="w-full gap-2" onClick={handleBatchUpload}
                disabled={!batchClass || batchFiles.length === 0 || batchUploadMutation.isPending || !!batchProgress}>
                <Upload className="w-4 h-4" />
                {batchUploadMutation.isPending ? "Uploading to S3..." : `Upload ${batchFiles.length > 0 ? batchFiles.length + " " : ""}Images`}
              </Button>
            </CardContent>
          </Card>
        </div>

        {/* Class Progress Grid */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center justify-between">
              <span>Class Progress ({readyClasses}/{totalClasses} at target · {qualityReadyClasses} quality-gated)</span>
              <div className="flex items-center gap-2">
                <Button variant={filterNeedingImages ? "default" : "outline"} size="sm"
                  className="gap-1 h-7 text-xs" onClick={() => setFilterNeedingImages(!filterNeedingImages)}>
                  <Filter className="w-3 h-3" />Needs Images
                </Button>
                <Button variant="ghost" size="sm" onClick={() => refetchClasses()}>
                  <RefreshCw className="w-3 h-3" />
                </Button>
              </div>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 max-h-96 overflow-y-auto pr-1">
              {displayedClasses.map(c => (
                <button key={c.className}
                  onClick={() => setViewClass(viewClass === c.className ? null : c.className)}
                  className={`w-full px-3 py-2 rounded-lg text-sm transition-colors text-left border ${
                    viewClass === c.className ? "bg-primary/10 border-primary/30" : "hover:bg-muted/50 border-transparent"
                  }`}
                >
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="font-medium truncate text-xs">{c.displayName}</span>
                    {getProgressBadge(c)}
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
                      <div className={`h-full rounded-full transition-all ${getProgressColor(c.totalImages)}`}
                        style={{ width: `${Math.min(100, (c.totalImages / targetCount) * 100)}%` }} />
                    </div>
                    <span className="text-xs text-muted-foreground shrink-0">
                      {c.totalImages}/{targetCount}
                      {c.qualityImages !== undefined && c.qualityImages < c.totalImages && (
                        <span className="text-amber-500 ml-1">({c.qualityImages}★)</span>
                      )}
                    </span>
                  </div>
                </button>
              ))}
              {displayedClasses.length === 0 && (
                <div className="col-span-3 text-center py-8 text-muted-foreground text-sm">
                  <CheckCircle2 className="w-8 h-8 text-green-500 mx-auto mb-2" />
                  All classes have reached the target of {targetCount} images!
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Class Image Gallery */}
        {viewClass && classImages && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                {classes?.find(c => c.className === viewClass)?.displayName} — {classImages.length} images
              </CardTitle>
            </CardHeader>
            <CardContent>
              {classImages.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">No images yet for this class. Upload some above!</p>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
                  {classImages.map(img => (
                    <div key={img.id} className="relative group">
                      <img src={img.imageUrl} alt={img.displayName}
                        className="w-full h-24 object-contain rounded-lg border bg-muted" />
                      <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity rounded-lg flex flex-col items-center justify-center gap-1">
                        <div className="flex gap-0.5">
                          {[1,2,3,4,5].map(n => (
                            <button key={n}
                              onClick={() => rateMutation.mutate({ id: img.id, qualityScore: n })}
                              className={`${n <= (img.qualityScore ?? 0) ? "text-yellow-400" : "text-white/40"}`}>
                              <Star className="w-3 h-3 fill-current" />
                            </button>
                          ))}
                        </div>
                        <button onClick={() => deleteMutation.mutate({ id: img.id })}
                          className="text-red-400 hover:text-red-300">
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                      <div className="mt-1">
                        <Badge variant="outline" className="text-xs w-full justify-center">{img.source}</Badge>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        )}
      </div>

      {/* Hidden file inputs */}
      <input ref={fileInputRef} type="file" accept="image/*" className="hidden"
        onChange={e => { const f = e.target.files?.[0]; if (f) handleFileSelect(f, "upload"); e.target.value = ""; }} />
      <input ref={cameraInputRef} type="file" accept="image/*" capture="environment" className="hidden"
        onChange={e => { const f = e.target.files?.[0]; if (f) handleFileSelect(f, "camera"); e.target.value = ""; }} />
      <input ref={batchInputRef} type="file" accept="image/*" multiple className="hidden"
        onChange={e => { if (e.target.files) handleBatchFileSelect(e.target.files); e.target.value = ""; }} />
    </DashboardLayout>
  );
}
