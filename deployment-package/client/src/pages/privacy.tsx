import { Button } from "@/components/ui/button";
import { Link } from "wouter";
import { ArrowLeft } from "lucide-react";

export default function Privacy() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="container mx-auto px-6 py-12 max-w-4xl">
        <Link href="/">
          <Button variant="ghost" className="mb-8">
            <ArrowLeft size={16} className="mr-2" />
            Back to Home
          </Button>
        </Link>

        <h1 className="text-4xl font-bold mb-8">Privacy Policy</h1>
        
        <div className="space-y-6 text-muted-foreground">
          <section>
            <h2 className="text-2xl font-semibold text-foreground mb-3">1. Overview</h2>
            <p>
              This Privacy Policy explains how Masquerade handles data when you use our video masking and frame extraction tool. We are committed to protecting your privacy and ensuring the security of your research data.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-foreground mb-3">2. Data We DO NOT Collect</h2>
            <p>
              Masquerade is designed with privacy as a core principle:
            </p>
            <ul className="list-disc list-inside ml-4 mt-2 space-y-1">
              <li><strong>Your video files:</strong> All video processing happens locally in your browser. Your files never leave your device.</li>
              <li><strong>Patient data:</strong> We do not have access to any medical imaging data you process.</li>
              <li><strong>Processed outputs:</strong> Downloaded frames and results remain on your local device.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-foreground mb-3">3. Data We Collect</h2>
            <p>
              We collect minimal analytics data to improve the service:
            </p>
            <ul className="list-disc list-inside ml-4 mt-2 space-y-1">
              <li><strong>Usage analytics:</strong> Anonymous usage statistics (e.g., file upload events, processing completion) via PostHog</li>
              <li><strong>Technical information:</strong> Browser type, device type, and basic performance metrics</li>
              <li><strong>Email address:</strong> Only if you sign up for the beta program via Mailchimp</li>
            </ul>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-foreground mb-3">4. How We Use Data</h2>
            <p>
              The limited data we collect is used to:
            </p>
            <ul className="list-disc list-inside ml-4 mt-2 space-y-1">
              <li>Improve software performance and user experience</li>
              <li>Debug technical issues</li>
              <li>Communicate beta program updates (if you've signed up)</li>
              <li>Understand feature usage patterns</li>
            </ul>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-foreground mb-3">5. Third-Party Services</h2>
            <p>
              We use the following third-party services:
            </p>
            <ul className="list-disc list-inside ml-4 mt-2 space-y-1">
              <li><strong>PostHog:</strong> Privacy-focused analytics to track anonymous usage patterns</li>
              <li><strong>Mailchimp:</strong> Email management for beta program communications (opt-in only)</li>
            </ul>
            <p className="mt-2">
              These services have their own privacy policies and we encourage you to review them.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-foreground mb-3">6. Your Responsibilities</h2>
            <p>
              When using Masquerade, you are responsible for:
            </p>
            <ul className="list-disc list-inside ml-4 mt-2 space-y-1">
              <li>De-identifying or anonymizing patient data before processing</li>
              <li>Ensuring compliance with HIPAA, GDPR, and institutional policies</li>
              <li>Obtaining necessary approvals (IRB, ethics committee) for your research</li>
              <li>Securing your local device and processed data</li>
            </ul>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-foreground mb-3">7. Data Security</h2>
            <p>
              We implement security measures including:
            </p>
            <ul className="list-disc list-inside ml-4 mt-2 space-y-1">
              <li>Local-only processing (no cloud uploads)</li>
              <li>HTTPS encryption for all communications</li>
              <li>Minimal data collection practices</li>
              <li>Regular security updates</li>
            </ul>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-foreground mb-3">8. Cookies and Tracking</h2>
            <p>
              We use minimal cookies for:
            </p>
            <ul className="list-disc list-inside ml-4 mt-2 space-y-1">
              <li>Session management</li>
              <li>Analytics (anonymous, via PostHog)</li>
            </ul>
            <p className="mt-2">
              You can disable cookies in your browser settings, though this may affect functionality.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-foreground mb-3">9. Your Rights</h2>
            <p>
              You have the right to:
            </p>
            <ul className="list-disc list-inside ml-4 mt-2 space-y-1">
              <li>Access any personal data we hold (email address only)</li>
              <li>Request deletion of your email from our mailing list</li>
              <li>Opt out of analytics tracking</li>
              <li>Use the software without providing any personal information</li>
            </ul>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-foreground mb-3">10. Children's Privacy</h2>
            <p>
              Masquerade is not intended for use by individuals under 18 years of age. We do not knowingly collect data from children.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-foreground mb-3">11. Changes to This Policy</h2>
            <p>
              We may update this Privacy Policy periodically. Continued use of the software after changes constitutes acceptance of the updated policy.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-foreground mb-3">12. Contact Us</h2>
            <p>
              For privacy-related questions or requests, contact us via LinkedIn at{" "}
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
