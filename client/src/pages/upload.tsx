import { useState, useRef } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/hooks/use-toast";
import { CloudUpload, FileVideo, FileImage, Rocket } from "lucide-react";
import { cn } from "@/lib/utils";
import { cacheUploadData } from "@/lib/frameCache";

type PhiChoice = "contains_phi" | "no_phi" | null;

export default function UploadPage() {
  const [, navigate] = useLocation();
  const { toast } = useToast();

  // File state
  const [dragOver, setDragOver] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [fileType, setFileType] = useState<"video" | "images" | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Attestation state
  const [phiChoice, setPhiChoice] = useState<PhiChoice>(null);

  // Upload state
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);

  const canSubmit = selectedFiles.length > 0 && phiChoice !== null && !isUploading;

  // ── File selection & validation ─────────────────────────────────────────

  const handleFileSelect = (files: FileList | File[]) => {
    const fileArray = Array.from(files);
    if (fileArray.length === 0) return;

    const videoTypes = ["video/mp4", "video/quicktime", "video/x-msvideo"];
    const imageTypes = ["image/png", "image/jpeg", "image/jpg"];
    const videoExtensions = /\.(mp4|mov|avi|dcm)$/i;
    const imageExtensions = /\.(png|jpg|jpeg)$/i;

    const hasVideo = fileArray.some(
      (f) => videoTypes.includes(f.type) || videoExtensions.test(f.name),
    );
    const hasImages = fileArray.some(
      (f) => imageTypes.includes(f.type) || imageExtensions.test(f.name),
    );

    if (hasVideo && hasImages) {
      toast({ title: "Mixed file types", description: "Upload either videos OR images, not both.", variant: "destructive" });
      return;
    }

    if (hasVideo) {
      if (fileArray.length > 1) {
        toast({ title: "Multiple videos", description: "Upload only one video at a time.", variant: "destructive" });
        return;
      }
      const f = fileArray[0];
      if (f.size > 500 * 1024 * 1024) {
        toast({ title: "File too large", description: "Video must be under 500 MB.", variant: "destructive" });
        return;
      }
      setFileType("video");
      setSelectedFiles([f]);
      return;
    }

    if (hasImages) {
      const oversized = fileArray.filter((f) => f.size > 50 * 1024 * 1024);
      if (oversized.length > 0) {
        toast({ title: "File too large", description: "Each image must be under 50 MB.", variant: "destructive" });
        return;
      }
      setFileType("images");
      setSelectedFiles(fileArray);
      return;
    }

    toast({ title: "Invalid file type", description: "Supported: MP4, MOV, AVI, DICOM, PNG, JPG.", variant: "destructive" });
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files.length > 0) handleFileSelect(e.dataTransfer.files);
  };

  const clearFiles = () => {
    setSelectedFiles([]);
    setFileType(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  // ── Submit ──────────────────────────────────────────────────────────────

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setIsUploading(true);
    setUploadProgress(0);

    const formData = new FormData();
    if (fileType === "video") {
      formData.append("video", selectedFiles[0]);
    } else {
      selectedFiles.forEach((f) => formData.append("images", f));
    }

    formData.append("phiStatus", "user_attested");
    formData.append(
      "attestationRecord",
      JSON.stringify({
        attestedAt: new Date().toISOString(),
        choice: phiChoice,
      }),
    );

    const endpoint =
      fileType === "video" ? "/api/uploads/video" : "/api/uploads/images";

    try {
      const result = await new Promise<{ jobId: string; metadata: Record<string, unknown>; firstFrame: string }>(
        (resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) setUploadProgress(Math.round((e.loaded / e.total) * 100));
          };
          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
              try { resolve(JSON.parse(xhr.responseText)); }
              catch { reject(new Error("Invalid response")); }
            } else {
              reject(new Error(xhr.responseText || "Upload failed"));
            }
          };
          xhr.onerror = () => reject(new Error("Network error"));
          xhr.ontimeout = () => reject(new Error("Upload timeout"));
          xhr.open("POST", endpoint);
          xhr.send(formData);
        },
      );

      // Cache firstFrame + metadata for spoke pages
      cacheUploadData(result.jobId, result.firstFrame, result.metadata);

      // Navigate to hub — do NOT read ffprobe metadata from upload response
      navigate(`/jobs/${result.jobId}`);
    } catch (err) {
      console.error("Upload error:", err);
      toast({
        title: "Upload failed",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
      setIsUploading(false);
      setUploadProgress(0);
    }
  };

  // ── Render ──────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      {/* Header */}
      <header className="border-b border-border bg-card">
        <div className="flex items-center px-6 py-4">
          <div className="flex items-center space-x-3">
            <div className="w-8 h-8 bg-primary rounded-lg flex items-center justify-center">
              <FileVideo className="text-primary-foreground" size={16} />
            </div>
            <div>
              <h1 className="text-xl font-bold text-foreground">Masquerade</h1>
              <p className="text-xs text-muted-foreground">High-Performance Video Processing</p>
            </div>
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className="flex-1 flex items-center justify-center p-8">
        <div className="w-full max-w-2xl space-y-8">
          {/* Top half: file picker */}
          <div
            className={cn(
              "border-2 border-dashed rounded-xl p-10 text-center transition-colors cursor-pointer",
              dragOver ? "border-primary bg-primary/5" : "border-border hover:border-primary/60",
            )}
            onDrop={handleDrop}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={(e) => { e.preventDefault(); setDragOver(false); }}
            onClick={() => fileInputRef.current?.click()}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".mp4,.mov,.avi,.dcm,.png,.jpg,.jpeg,video/mp4,video/quicktime,video/x-msvideo,image/png,image/jpeg"
              multiple
              className="hidden"
              onChange={(e) => e.target.files && handleFileSelect(e.target.files)}
            />

            {selectedFiles.length === 0 ? (
              <>
                <CloudUpload className="mx-auto mb-4 text-muted-foreground" size={48} />
                <p className="text-sm font-medium mb-1">Drop files here or click to browse</p>
                <p className="text-xs text-muted-foreground">
                  Videos: MP4, MOV, AVI, DICOM (max 500 MB) &middot; Images: PNG, JPG (max 50 MB each)
                </p>
              </>
            ) : (
              <div className="flex items-center justify-center gap-3">
                {fileType === "video" ? <FileVideo size={20} /> : <FileImage size={20} />}
                <span className="font-medium text-sm">
                  {fileType === "video"
                    ? selectedFiles[0].name
                    : `${selectedFiles.length} image${selectedFiles.length > 1 ? "s" : ""} selected`}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2"
                  onClick={(e) => { e.stopPropagation(); clearFiles(); }}
                >
                  Change
                </Button>
              </div>
            )}
          </div>

          {/* Upload progress */}
          {isUploading && (
            <div className="space-y-2">
              <Progress value={uploadProgress} />
              <p className="text-xs text-muted-foreground text-center">Uploading… {uploadProgress}%</p>
            </div>
          )}

          {/* Bottom half: attestation */}
          <div className="border border-border rounded-xl p-6 space-y-4">
            <div>
              <p className="text-sm font-semibold mb-1">PHI Attestation</p>
              <p className="text-xs text-muted-foreground">
                Does this upload contain Protected Health Information (PHI)?
              </p>
            </div>

            <div className="space-y-2">
              <label className="flex items-center gap-3 p-3 rounded-lg border border-border cursor-pointer hover:bg-muted/50 transition-colors">
                <input
                  type="radio"
                  name="phi"
                  value="no_phi"
                  checked={phiChoice === "no_phi"}
                  onChange={() => setPhiChoice("no_phi")}
                  className="accent-primary"
                />
                <div>
                  <span className="text-sm font-medium">No PHI</span>
                  <p className="text-xs text-muted-foreground">This upload does not contain protected health information.</p>
                </div>
              </label>

              <label className="flex items-center gap-3 p-3 rounded-lg border border-border cursor-pointer hover:bg-muted/50 transition-colors">
                <input
                  type="radio"
                  name="phi"
                  value="contains_phi"
                  checked={phiChoice === "contains_phi"}
                  onChange={() => setPhiChoice("contains_phi")}
                  className="accent-primary"
                />
                <div>
                  <span className="text-sm font-medium">Contains PHI</span>
                  <p className="text-xs text-muted-foreground">This upload contains protected health information.</p>
                </div>
              </label>
            </div>
          </div>

          {/* Let's Go button */}
          <div className="flex justify-end">
            <Button
              size="lg"
              disabled={!canSubmit}
              onClick={handleSubmit}
              className="gap-2"
            >
              <Rocket size={18} />
              Let&apos;s Go
            </Button>
          </div>
        </div>
      </main>
    </div>
  );
}
