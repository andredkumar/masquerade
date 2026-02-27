import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Link } from "wouter";
import { 
  Clock, 
  Wrench, 
  TrendingUp, 
  Pencil, 
  Zap, 
  Download,
  Upload,
  Edit,
  Package,
  ArrowRight,
  Shield,
  HelpCircle
} from "lucide-react";
import heroGif from "@assets/ezgif-35c303285ed42c_1759721392554.gif";

export default function Landing() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Hero Section */}
      <section className="relative overflow-hidden border-b border-border">
        <div className="container mx-auto px-6 py-16 lg:py-24">
          <div className="grid lg:grid-cols-2 gap-12 items-center">
            <div className="space-y-6">
              <h1 className="text-4xl md:text-5xl lg:text-6xl font-bold leading-tight" data-testid="text-hero-headline">
                Turn Hours of Ultrasound Dataset Prep Into Minutes
              </h1>
              <p className="text-xl text-muted-foreground" data-testid="text-hero-subheadline">
                DICOM-optimized video masking for POCUS ML research
              </p>
              <div className="pt-4 flex flex-col sm:flex-row gap-4">
                <a 
                  href="http://eepurl.com/joPd1E" 
                  target="_blank" 
                  rel="noopener noreferrer"
                >
                  <Button size="lg" className="text-lg px-8 py-6 w-full sm:w-auto" data-testid="button-join-beta">
                    Get Beta Access
                  </Button>
                </a>
                <Link href="/app">
                  <Button size="lg" variant="outline" className="text-lg px-8 py-6 w-full sm:w-auto" data-testid="button-start-app">
                    Already Signed Up? Start Here
                    <ArrowRight className="ml-2" size={20} />
                  </Button>
                </Link>
              </div>
            </div>
            
            {/* Hero Visual */}
            <div className="relative">
              <img 
                src={heroGif} 
                alt="Interactive masking interface demonstration" 
                className="rounded-lg border-2 border-border shadow-2xl w-full"
                data-testid="img-hero-demo"
              />
            </div>
          </div>
        </div>
      </section>

      {/* Problem Section */}
      <section className="py-16 lg:py-24 border-b border-border">
        <div className="container mx-auto px-6">
          <h2 className="text-3xl md:text-4xl font-bold text-center mb-12" data-testid="text-problem-heading">
            The Dataset Preparation Challenge
          </h2>
          <div className="grid md:grid-cols-3 gap-8 max-w-5xl mx-auto">
            <Card data-testid="card-problem-1">
              <CardContent className="pt-6 space-y-4">
                <div className="w-12 h-12 bg-destructive/10 rounded-lg flex items-center justify-center mx-auto">
                  <Clock className="text-destructive" size={24} />
                </div>
                <p className="text-lg">
                  Manually extracting frames from medical videos wastes 20+ hours per project
                </p>
              </CardContent>
            </Card>
            
            <Card data-testid="card-problem-2">
              <CardContent className="pt-6 space-y-4">
                <div className="w-12 h-12 bg-destructive/10 rounded-lg flex items-center justify-center mx-auto">
                  <Wrench className="text-destructive" size={24} />
                </div>
                <p className="text-lg">
                  Video editing tools aren't built for DICOM or medical imaging workflows
                </p>
              </CardContent>
            </Card>
            
            <Card data-testid="card-problem-3">
              <CardContent className="pt-6 space-y-4">
                <div className="w-12 h-12 bg-destructive/10 rounded-lg flex items-center justify-center mx-auto">
                  <TrendingUp className="text-destructive" size={24} />
                </div>
                <p className="text-lg">
                  Dataset preparation bottlenecks your ML research timeline
                </p>
              </CardContent>
            </Card>
          </div>
        </div>
      </section>

      {/* Solution Section */}
      <section className="py-16 lg:py-24 bg-muted/50">
        <div className="container mx-auto px-6">
          <h2 className="text-3xl md:text-4xl font-bold text-center mb-12" data-testid="text-solution-heading">
            Purpose-Built for Medical ML Research
          </h2>
          <div className="grid md:grid-cols-3 gap-8 max-w-5xl mx-auto">
            <Card data-testid="card-solution-masking">
              <CardContent className="pt-6 space-y-4">
                <div className="w-12 h-12 bg-primary/10 rounded-lg flex items-center justify-center mx-auto">
                  <Pencil className="text-primary" size={24} />
                </div>
                <h3 className="text-xl font-semibold">Interactive Masking</h3>
                <p className="text-muted-foreground">
                  Rectangle, polygon, and brush tools for precise ROI selection
                </p>
              </CardContent>
            </Card>
            
            <Card data-testid="card-solution-batch">
              <CardContent className="pt-6 space-y-4">
                <div className="w-12 h-12 bg-primary/10 rounded-lg flex items-center justify-center mx-auto">
                  <Zap className="text-primary" size={24} />
                </div>
                <h3 className="text-xl font-semibold">Batch Processing</h3>
                <p className="text-muted-foreground">
                  Extract 1000+ frames in minutes with parallel processing
                </p>
              </CardContent>
            </Card>
            
            <Card data-testid="card-solution-output">
              <CardContent className="pt-6 space-y-4">
                <div className="w-12 h-12 bg-primary/10 rounded-lg flex items-center justify-center mx-auto">
                  <Download className="text-primary" size={24} />
                </div>
                <h3 className="text-xl font-semibold">ML-Ready Output</h3>
                <p className="text-muted-foreground">
                  Export to standard formats (224x224, 512x512, etc.) for immediate training
                </p>
              </CardContent>
            </Card>
          </div>
        </div>
      </section>

      {/* How It Works Section */}
      <section className="py-16 lg:py-24">
        <div className="container mx-auto px-6">
          <h2 className="text-3xl md:text-4xl font-bold text-center mb-12" data-testid="text-howitworks-heading">
            How It Works
          </h2>
          <div className="max-w-6xl mx-auto grid lg:grid-cols-2 gap-12 items-center">
            <div className="space-y-8">
              <div className="flex gap-6 items-start" data-testid="step-upload">
                <div className="flex-shrink-0 w-12 h-12 bg-primary text-primary-foreground rounded-full flex items-center justify-center text-xl font-bold">
                  1
                </div>
                <div className="flex-1 space-y-2">
                  <div className="flex items-center gap-3">
                    <Upload className="text-primary" size={24} />
                    <h3 className="text-xl font-semibold">Upload your DICOM/video file</h3>
                  </div>
                  <p className="text-muted-foreground">
                    Support for DICOM, MP4, JPG, and PNG formats. Handle files up to 500MB with automatic metadata extraction.
                  </p>
                </div>
              </div>

              <div className="flex gap-6 items-start" data-testid="step-mask">
                <div className="flex-shrink-0 w-12 h-12 bg-primary text-primary-foreground rounded-full flex items-center justify-center text-xl font-bold">
                  2
                </div>
                <div className="flex-1 space-y-2">
                  <div className="flex items-center gap-3">
                    <Edit className="text-primary" size={24} />
                    <h3 className="text-xl font-semibold">Draw masks on regions of interest</h3>
                  </div>
                  <p className="text-muted-foreground">
                    Use interactive tools to define your ROI with pixel-perfect precision. Apply the same mask template to all frames instantly.
                  </p>
                </div>
              </div>

              <div className="flex gap-6 items-start" data-testid="step-export">
                <div className="flex-shrink-0 w-12 h-12 bg-primary text-primary-foreground rounded-full flex items-center justify-center text-xl font-bold">
                  3
                </div>
                <div className="flex-1 space-y-2">
                  <div className="flex items-center gap-3">
                    <Package className="text-primary" size={24} />
                    <h3 className="text-xl font-semibold">Export standardized frames for your ML pipeline</h3>
                  </div>
                  <p className="text-muted-foreground">
                    Download processed frames as a ZIP archive or video, ready for training. Choose from standard ML dimensions or custom sizes.
                  </p>
                </div>
              </div>
            </div>

            <div className="relative aspect-video rounded-lg overflow-hidden border-2 border-border shadow-xl">
              <iframe
                className="absolute inset-0 w-full h-full"
                src="https://www.youtube.com/embed/UkuVrjG8Y_4"
                title="Masquerade Demo Video"
                frameBorder="0"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowFullScreen
                data-testid="demo-video"
              />
            </div>
          </div>
        </div>
      </section>

      {/* FAQ Section */}
      <section className="py-16 lg:py-24">
        <div className="container mx-auto px-6">
          <h2 className="text-3xl md:text-4xl font-bold text-center mb-12" data-testid="text-faq-heading">
            Frequently Asked Questions
          </h2>
          <div className="max-w-3xl mx-auto space-y-6">
            <Card>
              <CardContent className="pt-6">
                <div className="flex gap-4">
                  <HelpCircle className="text-primary flex-shrink-0 mt-1" size={20} />
                  <div>
                    <h3 className="font-semibold mb-2">Is my data secure?</h3>
                    <p className="text-sm text-muted-foreground">
                      All processing happens locally in your browser. Your video files and masks never leave your device unless you explicitly download the processed results.
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="pt-6">
                <div className="flex gap-4">
                  <HelpCircle className="text-primary flex-shrink-0 mt-1" size={20} />
                  <div>
                    <h3 className="font-semibold mb-2">What file formats are supported?</h3>
                    <p className="text-sm text-muted-foreground">
                      Masquerade supports DICOM files as well as standard image and video formats including MP4, MOV, AVI, JPG, and PNG. Maximum file size is 500MB.
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="pt-6">
                <div className="flex gap-4">
                  <HelpCircle className="text-primary flex-shrink-0 mt-1" size={20} />
                  <div>
                    <h3 className="font-semibold mb-2">Can I use this for clinical purposes?</h3>
                    <p className="text-sm text-muted-foreground">
                      No. Masquerade is designed exclusively for research and educational purposes. It is not intended for clinical diagnosis or patient care.
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="pt-6">
                <div className="flex gap-4">
                  <HelpCircle className="text-primary flex-shrink-0 mt-1" size={20} />
                  <div>
                    <h3 className="font-semibold mb-2">How long does processing take?</h3>
                    <p className="text-sm text-muted-foreground">
                      Processing speed depends on your video length and system specs. Typically, Masquerade can process 1000+ frames in just a few minutes using parallel processing.
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </section>

      {/* Legal Disclaimer Section */}
      <section className="py-12 bg-muted/30 border-y border-border">
        <div className="container mx-auto px-6">
          <div className="max-w-4xl mx-auto">
            <div className="flex gap-4 items-start">
              <Shield className="text-muted-foreground flex-shrink-0 mt-1" size={24} />
              <div>
                <h3 className="font-semibold mb-2">Research Use Only</h3>
                <p className="text-sm text-muted-foreground">
                  This software is provided for research and educational purposes only. It is not FDA-approved, CE-marked, or intended for clinical use, diagnosis, or patient care. Users are responsible for ensuring compliance with applicable regulations including HIPAA, GDPR, and institutional review board (IRB) requirements when processing medical data.
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-border py-12">
        <div className="container mx-auto px-6">
          <div className="text-center space-y-6">
            <p className="text-lg font-medium">Join 50+ researchers using Masquerade</p>
            <a
              href="http://eepurl.com/joPd1E"
              target="_blank"
              rel="noopener noreferrer"
            >
              <Button size="lg" className="text-lg px-8 py-6" data-testid="button-footer-signup">
                Sign Up for Beta
                <ArrowRight className="ml-2" size={20} />
              </Button>
            </a>
            <div className="pt-8 space-y-4">
              <div className="flex flex-col md:flex-row justify-center items-center gap-4 text-sm text-muted-foreground">
                <a
                  href="/terms"
                  className="text-primary hover:underline"
                  data-testid="link-terms"
                >
                  Terms of Use
                </a>
                <span className="hidden md:inline">•</span>
                <a
                  href="/privacy"
                  className="text-primary hover:underline"
                  data-testid="link-privacy"
                >
                  Privacy Policy
                </a>
                <span className="hidden md:inline">•</span>
                <a
                  href="https://www.linkedin.com/in/andre-kumar-md-med-9a3887a2/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline"
                  data-testid="link-linkedin"
                >
                  Connect on LinkedIn
                </a>
              </div>
              <div className="text-xs text-muted-foreground" data-testid="text-disclaimer">
                For research purposes only
              </div>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
