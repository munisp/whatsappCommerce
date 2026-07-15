import { useState, useRef, useCallback } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { Camera, Upload, Star, Trash2, CheckCircle2, AlertCircle, BarChart3, Download, RefreshCw } from "lucide-react";

export default function ProductImageCollector() {
  const [selectedClass, setSelectedClass] = useState<string>("");
  const [capturedImage, setCapturedImage] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [qualityScore, setQualityScore] = useState<number>(3);
  const [source, setSource] = useState<"camera" | "upload">("upload");
  const [viewClass, setViewClass] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);

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

  const readyClasses = classes?.filter(c => c.isReady).length ?? 0;
  const totalClasses = classes?.length ?? 30;

  return (
    <DashboardLayout>
      <div className="p-6 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-foreground">Product Image Collector</h1>
            <p className="text-muted-foreground mt-1">Collect product photos for YOLO training dataset — Nigerian FMCG classes</p>
          </div>
          <Button
            onClick={() => exportMutation.mutate()}
            disabled={exportMutation.isPending}
            variant="outline"
            className="gap-2"
          >
            <Download className="w-4 h-4" />
            {exportMutation.isPending ? "Exporting..." : "Export Dataset Manifest"}
          </Button>
        </div>

        {/* Dataset Stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[
            { label: "Total Images", value: stats?.totalImages ?? 0, icon: <BarChart3 className="w-5 h-5 text-blue-500" /> },
            { label: "Classes with Images", value: stats?.classesWithImages ?? 0, icon: <CheckCircle2 className="w-5 h-5 text-green-500" /> },
            { label: "Classes Ready (≥2)", value: `${readyClasses}/${totalClasses}`, icon: <CheckCircle2 className="w-5 h-5 text-emerald-500" /> },
            { label: "Classes Needed", value: totalClasses - readyClasses, icon: <AlertCircle className="w-5 h-5 text-amber-500" /> },
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

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Upload Panel */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Add Product Image</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Class selector */}
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
                          {c.isReady && <CheckCircle2 className="w-3 h-3 text-green-500" />}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Image preview */}
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
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-2"
                      onClick={() => cameraInputRef.current?.click()}
                    >
                      <Camera className="w-4 h-4" />
                      Camera
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-2"
                      onClick={() => fileInputRef.current?.click()}
                    >
                      <Upload className="w-4 h-4" />
                      Upload File
                    </Button>
                  </div>
                </div>
              )}

              {/* Hidden file inputs */}
              <input
                ref={cameraInputRef}
                type="file"
                accept="image/*"
                capture="environment"
                className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFileSelect(f, "camera"); }}
              />
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFileSelect(f, "upload"); }}
              />

              {/* Quality rating */}
              <div>
                <label className="text-sm font-medium mb-1 block">Image Quality</label>
                <div className="flex gap-1">
                  {[1, 2, 3, 4, 5].map(n => (
                    <button
                      key={n}
                      onClick={() => setQualityScore(n)}
                      className={`p-1 transition-colors ${n <= qualityScore ? "text-yellow-400" : "text-muted-foreground/30"}`}
                    >
                      <Star className="w-5 h-5 fill-current" />
                    </button>
                  ))}
                  <span className="ml-2 text-xs text-muted-foreground self-center">
                    {["", "Poor", "Fair", "Good", "Great", "Perfect"][qualityScore]}
                  </span>
                </div>
              </div>

              {/* Notes */}
              <div>
                <label className="text-sm font-medium mb-1 block">Notes (optional)</label>
                <Textarea
                  placeholder="e.g. 70g pack, white background, good lighting"
                  value={notes}
                  onChange={e => setNotes(e.target.value)}
                  rows={2}
                />
              </div>

              <Button
                className="w-full"
                onClick={handleUpload}
                disabled={!capturedImage || !selectedClass || uploadMutation.isPending}
              >
                {uploadMutation.isPending ? "Uploading..." : "Upload to Dataset"}
              </Button>
            </CardContent>
          </Card>

          {/* Class Grid */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center justify-between">
                <span>Class Progress</span>
                <Button variant="ghost" size="sm" onClick={() => refetchClasses()}>
                  <RefreshCw className="w-3 h-3" />
                </Button>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-1 max-h-96 overflow-y-auto pr-1">
                {classes?.map(c => (
                  <button
                    key={c.className}
                    onClick={() => setViewClass(viewClass === c.className ? null : c.className)}
                    className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-sm transition-colors text-left ${
                      viewClass === c.className ? "bg-primary/10 border border-primary/20" : "hover:bg-muted/50"
                    }`}
                  >
                    <span className="font-medium truncate">{c.displayName}</span>
                    <div className="flex items-center gap-2 ml-2 shrink-0">
                      <span className="text-xs text-muted-foreground">{c.totalImages} imgs</span>
                      {c.isReady
                        ? <Badge className="text-xs bg-green-500/10 text-green-700 border-green-200">Ready</Badge>
                        : <Badge variant="outline" className="text-xs text-amber-600 border-amber-200">Need more</Badge>
                      }
                    </div>
                  </button>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>

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
                      <img
                        src={img.imageUrl}
                        alt={img.displayName}
                        className="w-full h-24 object-contain rounded-lg border bg-muted"
                      />
                      <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity rounded-lg flex flex-col items-center justify-center gap-1">
                        <div className="flex gap-0.5">
                          {[1,2,3,4,5].map(n => (
                            <button
                              key={n}
                              onClick={() => rateMutation.mutate({ id: img.id, qualityScore: n })}
                              className={`${n <= (img.qualityScore ?? 0) ? "text-yellow-400" : "text-white/40"}`}
                            >
                              <Star className="w-3 h-3 fill-current" />
                            </button>
                          ))}
                        </div>
                        <button
                          onClick={() => deleteMutation.mutate({ id: img.id })}
                          className="text-red-400 hover:text-red-300"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                      <div className="mt-1">
                        <Badge variant="outline" className="text-xs w-full justify-center">
                          {img.source}
                        </Badge>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </DashboardLayout>
  );
}
