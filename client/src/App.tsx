import { Switch, Route, useParams, Redirect } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import Landing from "@/pages/landing";
import UploadPage from "@/pages/upload";
import HubPage from "@/pages/hub";
import TemplateMaskSpokePage from "@/pages/template-mask-spoke";
import AiSpokePage from "@/pages/ai-spoke";
import Terms from "@/pages/terms";
import Privacy from "@/pages/privacy";
import NotFound from "@/pages/not-found";
import { JobProvider } from "@/contexts/JobContext";
import { useEffect } from "react";
import { initPostHog } from "./lib/posthog";

/**
 * Wrapper that reads :jobId from the URL and provides JobContext
 * to all /jobs/:jobId/* sub-routes.
 */
function JobRoutes() {
  // Inside a nested route, useParams captures :jobId from the parent path
  const params = useParams<{ jobId: string }>();
  const jobId = params.jobId;

  return (
    <JobProvider jobId={jobId}>
      <Switch>
        {/* Relative paths inside the nest base /jobs/:jobId */}
        <Route path="/" component={HubPage} />
        <Route path="/template-mask" component={TemplateMaskSpokePage} />
        <Route path="/ai" component={AiSpokePage} />
        <Route component={NotFound} />
      </Switch>
    </JobProvider>
  );
}

function Router() {
  return (
    <Switch>
      {/* Phase 4a: / redirects to /upload */}
      <Route path="/">
        <Redirect to="/upload" />
      </Route>
      <Route path="/upload" component={UploadPage} />
      {/* Job routes — wrapped in JobProvider */}
      <Route path="/jobs/:jobId" nest>
        {() => <JobRoutes />}
      </Route>
      <Route path="/terms" component={Terms} />
      <Route path="/privacy" component={Privacy} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  useEffect(() => {
    initPostHog();
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <Router />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
