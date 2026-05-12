import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from "react";
import type { Job } from "@shared/schema";
import { useWebSocket } from "@/hooks/useWebSocket";

interface JobContextValue {
  job: Job | null;
  isLoading: boolean;
  error: string | null;
  refetch: () => void;
}

const JobContext = createContext<JobContextValue | null>(null);

export function JobProvider({ jobId, children }: { jobId: string; children: ReactNode }) {
  const [job, setJob] = useState<Job | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { socket } = useWebSocket();

  const fetchJob = useCallback(async () => {
    try {
      const res = await fetch(`/api/jobs/${jobId}`);
      if (!res.ok) {
        if (res.status === 404) {
          setError("Job not found");
        } else {
          setError("Failed to load job");
        }
        setJob(null);
        return;
      }
      const data: Job = await res.json();
      setJob(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load job");
      setJob(null);
    } finally {
      setIsLoading(false);
    }
  }, [jobId]);

  // Initial fetch
  useEffect(() => {
    setIsLoading(true);
    fetchJob();
  }, [fetchJob]);

  // Refetch on Socket.IO progress events for this jobId
  useEffect(() => {
    if (!socket) return;

    const handleProgress = (data: { jobId?: string }) => {
      if (data.jobId === jobId) {
        fetchJob();
      }
    };

    socket.on("progress", handleProgress);
    return () => {
      socket.off("progress", handleProgress);
    };
  }, [socket, jobId, fetchJob]);

  return (
    <JobContext.Provider value={{ job, isLoading, error, refetch: fetchJob }}>
      {children}
    </JobContext.Provider>
  );
}

export function useJob(): JobContextValue {
  const ctx = useContext(JobContext);
  if (!ctx) {
    throw new Error("useJob must be used within a <JobProvider>");
  }
  return ctx;
}
