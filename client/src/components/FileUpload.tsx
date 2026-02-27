import { useState, useRef } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/hooks/use-toast";
import { CloudUpload, FileVideo, FileImage, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { posthog } from "@/lib/posthog";

interface FileUploadProps {
  onUploadComplete: (jobId: string, metadata: any, firstFrame: string) => void;
}

export default function FileUpload({ onUploadComplete }: FileUploadProps) {
  const [dragOver, setDragOver] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [currentFiles, setCurrentFiles] = useState<File[]>([]);
  const [fileType, setFileType] = useState<'video' | 'images' | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  const uploadMutation = useMutation({
    mutationFn: async (files: File[]) => {
      const formData = new FormData();
      
      if (fileType === 'video') {
        formData.append('video', files[0]);
      } else {
        files.forEach((file, index) => {
          formData.append('images', file);
        });
      }

      const endpoint = fileType === 'video' ? '/api/videos/upload' : '/api/images/upload';
      
      // Use XMLHttpRequest for real-time upload progress tracking
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        
        // Track upload progress
        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable) {
            const percentComplete = Math.round((event.loaded / event.total) * 100);
            setUploadProgress(percentComplete);
          }
        };
        
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            try {
              const result = JSON.parse(xhr.responseText);
              resolve(result);
            } catch (e) {
              reject(new Error('Invalid response format'));
            }
          } else {
            reject(new Error(xhr.responseText || 'Upload failed'));
          }
        };
        
        xhr.onerror = () => reject(new Error('Network error during upload'));
        xhr.ontimeout = () => reject(new Error('Upload timeout'));
        
        xhr.open('POST', endpoint);
        xhr.send(formData);
      });
    },
    onSuccess: (data: any) => {
      const fileCount = currentFiles.length;
      const description = fileType === 'video' 
        ? `${currentFiles[0]?.name} uploaded successfully`
        : `${fileCount} image${fileCount > 1 ? 's' : ''} uploaded successfully`;
      
      toast({
        title: "Upload Successful",
        description,
      });
      onUploadComplete(data.jobId, data.metadata, data.firstFrame);
      setUploadProgress(100);
      
      posthog.capture('file_uploaded', {
        file_type: fileType,
        file_count: fileCount,
        job_id: data.jobId
      });
    },
    onError: (error) => {
      console.error('Upload error:', error);
      toast({
        title: "Upload Failed",
        description: error instanceof Error ? error.message : `Failed to upload ${fileType === 'video' ? 'video' : 'images'}`,
        variant: "destructive",
      });
      setUploadProgress(0);
    },
  });

  const handleFileSelect = (files: FileList | File[]) => {
    const fileArray = Array.from(files);
    if (fileArray.length === 0) return;

    // Determine file type and validate consistency
    const videoTypes = ['video/mp4', 'video/quicktime', 'video/x-msvideo'];
    const imageTypes = ['image/png', 'image/jpeg', 'image/jpg'];
    const videoExtensions = /\.(mp4|mov|avi|dcm)$/i;
    const imageExtensions = /\.(png|jpg|jpeg)$/i;
    
    const hasVideo = fileArray.some(file => 
      videoTypes.includes(file.type) || videoExtensions.test(file.name)
    );
    const hasImages = fileArray.some(file => 
      imageTypes.includes(file.type) || imageExtensions.test(file.name)
    );
    
    // Check for mixed file types
    if (hasVideo && hasImages) {
      toast({
        title: "Mixed File Types",
        description: "Please upload either videos OR images, not both",
        variant: "destructive",
      });
      return;
    }
    
    // Video files - only allow single file
    if (hasVideo) {
      if (fileArray.length > 1) {
        toast({
          title: "Multiple Video Files",
          description: "Please upload only one video file at a time",
          variant: "destructive",
        });
        return;
      }
      
      const file = fileArray[0];
      if (!videoTypes.includes(file.type) && !videoExtensions.test(file.name)) {
        toast({
          title: "Invalid File Type",
          description: "Please select an MP4, MOV, AVI, or DICOM file",
          variant: "destructive",
        });
        return;
      }
      
      if (file.size > 500 * 1024 * 1024) {
        toast({
          title: "File Too Large",
          description: "Please select a video file smaller than 500MB",
          variant: "destructive",
        });
        return;
      }
      
      setFileType('video');
      setCurrentFiles([file]);
    }
    
    // Image files - allow multiple
    if (hasImages) {
      // Validate all files are images
      const invalidFiles = fileArray.filter(file => 
        !imageTypes.includes(file.type) && !imageExtensions.test(file.name)
      );
      
      if (invalidFiles.length > 0) {
        toast({
          title: "Invalid File Type",
          description: "Please select only PNG or JPG image files",
          variant: "destructive",
        });
        return;
      }
      
      // Check file sizes (50MB per image)
      const oversizedFiles = fileArray.filter(file => file.size > 50 * 1024 * 1024);
      if (oversizedFiles.length > 0) {
        toast({
          title: "File Too Large",
          description: "Please select image files smaller than 50MB each",
          variant: "destructive",
        });
        return;
      }
      
      setFileType('images');
      setCurrentFiles(fileArray);
    }
    
    if (!hasVideo && !hasImages) {
      toast({
        title: "Invalid File Type",
        description: "Please select video files (MP4, MOV, AVI, DICOM) or image files (PNG, JPG)",
        variant: "destructive",
      });
      return;
    }

    setUploadProgress(0);
    uploadMutation.mutate(fileArray);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    
    const files = e.dataTransfer.files;
    if (files.length > 0) {
      handleFileSelect(files);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      handleFileSelect(files);
    }
  };

  const handleBrowseClick = () => {
    fileInputRef.current?.click();
  };

  const handleReset = () => {
    setCurrentFiles([]);
    setFileType(null);
    setUploadProgress(0);
    uploadMutation.reset();
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const removeFile = (index: number) => {
    const newFiles = currentFiles.filter((_, i) => i !== index);
    setCurrentFiles(newFiles);
    if (newFiles.length === 0) {
      setFileType(null);
    }
  };

  return (
    <div className="p-6 border-b border-border">
      
      {/* File Upload Area */}
      <div 
        className={cn(
          "border-2 border-dashed rounded-lg p-6 text-center transition-colors cursor-pointer",
          dragOver ? "border-primary bg-primary/5" : "border-border hover:border-primary"
        )}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onClick={handleBrowseClick}
        data-testid="file-upload-area"
      >
        <div className="mb-4">
          <CloudUpload className="mx-auto text-3xl text-muted-foreground" size={48} />
        </div>
        <p className="text-sm font-medium mb-2">Drop files here or click to browse</p>
        <p className="text-xs text-muted-foreground mb-4">Videos: MP4, MOV, AVI, DICOM (Max 500MB) • Images: PNG, JPG (Max 50MB each)</p>
        
        <input
          ref={fileInputRef}
          type="file"
          accept=".mp4,.mov,.avi,.dcm,.png,.jpg,.jpeg,video/mp4,video/quicktime,video/x-msvideo,image/png,image/jpeg"
          multiple
          className="hidden"
          onChange={handleFileInputChange}
          data-testid="file-input"
        />
        
        <Button 
          disabled={uploadMutation.isPending}
          data-testid="select-file-button"
        >
          {uploadMutation.isPending ? "Uploading..." : "Select Files"}
        </Button>
      </div>

      {/* Upload Progress */}
      {uploadMutation.isPending && currentFiles.length > 0 && (
        <div className="mt-4 p-3 bg-muted rounded-lg" data-testid="upload-progress">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium flex items-center gap-2">
              {fileType === 'video' ? <FileVideo size={16} /> : <FileImage size={16} />}
              {fileType === 'video' 
                ? currentFiles[0].name 
                : `${currentFiles.length} image${currentFiles.length > 1 ? 's' : ''}`
              }
            </span>
            <span className="text-xs text-muted-foreground">
              {fileType === 'video' 
                ? `${(currentFiles[0].size / (1024 * 1024)).toFixed(1)} MB`
                : `${(currentFiles.reduce((acc, file) => acc + file.size, 0) / (1024 * 1024)).toFixed(1)} MB total`
              }
            </span>
          </div>
          <Progress value={uploadProgress} className="mb-2" data-testid="upload-progress-bar" />
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>Uploading...</span>
            <span data-testid="upload-percentage">{uploadProgress}%</span>
          </div>
        </div>
      )}

      {/* Upload Complete */}
      {uploadMutation.isSuccess && currentFiles.length > 0 && (
        <div className="mt-4 p-3 bg-muted rounded-lg" data-testid="upload-complete">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium flex items-center gap-2">
              {fileType === 'video' ? <FileVideo size={16} /> : <FileImage size={16} />}
              {fileType === 'video' 
                ? currentFiles[0].name 
                : `${currentFiles.length} image${currentFiles.length > 1 ? 's' : ''}`
              }
            </span>
            <span className="text-xs text-muted-foreground">
              {fileType === 'video' 
                ? `${(currentFiles[0].size / (1024 * 1024)).toFixed(1)} MB`
                : `${(currentFiles.reduce((acc, file) => acc + file.size, 0) / (1024 * 1024)).toFixed(1)} MB total`
              }
            </span>
          </div>
          <Progress value={100} className="mb-2" />
          
          {/* Show file list for images */}
          {fileType === 'images' && currentFiles.length > 1 && (
            <div className="mb-3">
              <div className="text-xs text-muted-foreground mb-2">Files:</div>
              <div className="max-h-32 overflow-y-auto space-y-1">
                {currentFiles.map((file, index) => (
                  <div key={index} className="flex items-center justify-between text-xs bg-background rounded px-2 py-1">
                    <span className="truncate">{file.name}</span>
                    <span className="text-muted-foreground ml-2">
                      {(file.size / (1024 * 1024)).toFixed(1)} MB
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
          
          <div className="flex justify-between items-center">
            <div className="text-xs text-muted-foreground">
              <div>Upload Complete</div>
              <div>Ready for masking</div>
            </div>
            <Button 
              size="sm" 
              variant="outline" 
              onClick={handleReset}
              data-testid="upload-new-file-button"
            >
              Upload New Files
            </Button>
          </div>
        </div>
      )}
      
      {/* Selected Files Preview (before upload) */}
      {!uploadMutation.isPending && !uploadMutation.isSuccess && currentFiles.length > 0 && (
        <div className="mt-4 p-3 bg-muted rounded-lg">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium flex items-center gap-2">
              {fileType === 'video' ? <FileVideo size={16} /> : <FileImage size={16} />}
              {fileType === 'video' 
                ? 'Video Ready' 
                : `${currentFiles.length} Image${currentFiles.length > 1 ? 's' : ''} Ready`
              }
            </span>
            <Button size="sm" variant="ghost" onClick={handleReset}>
              <X size={14} />
            </Button>
          </div>
          
          {fileType === 'images' && (
            <div className="space-y-2">
              {currentFiles.map((file, index) => (
                <div key={index} className="flex items-center justify-between text-xs bg-background rounded px-2 py-1">
                  <span className="truncate">{file.name}</span>
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground">
                      {(file.size / (1024 * 1024)).toFixed(1)} MB
                    </span>
                    <Button 
                      size="sm" 
                      variant="ghost" 
                      className="h-4 w-4 p-0"
                      onClick={() => removeFile(index)}
                    >
                      <X size={12} />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
          
          {fileType === 'video' && (
            <div className="text-xs text-muted-foreground">
              {currentFiles[0].name} ({(currentFiles[0].size / (1024 * 1024)).toFixed(1)} MB)
            </div>
          )}
        </div>
      )}
    </div>
  );
}
