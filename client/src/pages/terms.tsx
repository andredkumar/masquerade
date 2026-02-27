import { Button } from "@/components/ui/button";
import { Link } from "wouter";
import { ArrowLeft } from "lucide-react";

export default function Terms() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="container mx-auto px-6 py-12 max-w-4xl">
        <Link href="/">
          <Button variant="ghost" className="mb-8">
            <ArrowLeft size={16} className="mr-2" />
            Back to Home
          </Button>
        </Link>

        <h1 className="text-4xl font-bold mb-8">Terms of Use</h1>
        
        <div className="space-y-6 text-muted-foreground">
          <section>
            <h2 className="text-2xl font-semibold text-foreground mb-3">1. Acceptance of Terms</h2>
            <p>
              By accessing and using Masquerade, you accept and agree to be bound by these Terms of Use. If you do not agree to these terms, please do not use this software.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-foreground mb-3">2. Research Use Only</h2>
            <p>
              Masquerade is provided exclusively for research and educational purposes. This software is NOT:
            </p>
            <ul className="list-disc list-inside ml-4 mt-2 space-y-1">
              <li>FDA-approved or CE-marked</li>
              <li>Intended for clinical use, diagnosis, or patient care</li>
              <li>A medical device or diagnostic tool</li>
              <li>Suitable for making clinical decisions</li>
            </ul>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-foreground mb-3">3. User Responsibilities</h2>
            <p>
              You are solely responsible for:
            </p>
            <ul className="list-disc list-inside ml-4 mt-2 space-y-1">
              <li>Ensuring compliance with HIPAA, GDPR, and other applicable data protection regulations</li>
              <li>Obtaining necessary Institutional Review Board (IRB) approvals</li>
              <li>De-identifying or anonymizing patient data before processing</li>
              <li>Maintaining appropriate data security measures</li>
              <li>Ensuring you have proper authorization to use any medical imaging data</li>
            </ul>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-foreground mb-3">4. Data Processing</h2>
            <p>
              All video processing occurs locally in your browser. Your files are not uploaded to external servers. However, you are responsible for ensuring that any data you process complies with applicable privacy laws and institutional policies.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-foreground mb-3">5. Intellectual Property</h2>
            <p>
              The software and all related intellectual property rights remain the property of the developer. You are granted a limited, non-exclusive license to use the software for research purposes only.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-foreground mb-3">6. Disclaimer of Warranties</h2>
            <p>
              THE SOFTWARE IS PROVIDED "AS IS" WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED. We make no guarantees about the accuracy, reliability, or suitability of the software for any particular purpose.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-foreground mb-3">7. Limitation of Liability</h2>
            <p>
              In no event shall the developers be liable for any damages arising from the use or inability to use the software, including but not limited to data loss, research delays, or consequential damages.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-foreground mb-3">8. Beta Software</h2>
            <p>
              This software is currently in beta. Features may change, and bugs may occur. We recommend maintaining backups of your original data files.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-foreground mb-3">9. Modifications</h2>
            <p>
              We reserve the right to modify these terms at any time. Continued use of the software constitutes acceptance of any changes.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-foreground mb-3">10. Contact</h2>
            <p>
              For questions about these terms, please contact us via LinkedIn at{" "}
              <a 
                href="https://www.linkedin.com/in/andre-kumar-md-med-9a3887a2/"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                Andre Kumar, MD MEd
              </a>
            </p>
          </section>

          <div className="pt-8 text-sm">
            <p>Last Updated: January 2025</p>
          </div>
        </div>
      </div>
    </div>
  );
}
