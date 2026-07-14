import { createContext, useContext, useEffect, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Job } from "@shared/schema";
import { useWebSocket } from "@/hooks/useWebSocket";

interface JobContextValue {
  job: Job | null;
  isLoading: boolean;
  error: string | null;
  refetch: () => void;
}

const JobContext = createContext<JobContextValue | null>(null);

// Preserve the two user-facing messages the manual fetch used to produce.
function toErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message.startsWith("404")) return "Job not found";
  return "Failed to load job";
}

export function JobProvider({ jobId, children }: { jobId: string; children: ReactNode }) {
  const { socket } = useWebSocket();

  // Phase 5D: the hub's canonical job read. Uses the app's default queryFn
  // (lib/queryClient.ts) which resolves ['/api/jobs', jobId] → GET /api/jobs/:jobId.
  //
  // Bounded self-heal poll: 5B correctly scoped `progress` emits to the job room
  // (io.to(jobId)); this context's socket only enters that room via the `join`
  // below. The poll is the belt-and-suspenders fallback so a missed/late progress
  // emit (or a reconnect race) still lets the hub reach a terminal status instead
  // of hanging. It reuses ProcessingStatus's existing refetchInterval mechanism and
  // is bounded — it stops once the job is `ready` or `failed`.
  const query = useQuery<Job>({
    queryKey: ["/api/jobs", jobId],
    enabled: !!jobId,
    refetchInterval: (q) => {
      const status = q.state.data?.status;
      return status === "ready" || status === "failed" ? false : 2000;
    },
  });

  const { refetch } = query;
  const job = query.data ?? null;
  // Only surface an error when we have no job to show — a transient background
  // poll failure must not flip a working hub to the error screen mid-extraction.
  const error = query.isError && !query.data ? toErrorMessage(query.error) : null;

  // Join the job's Socket.IO room and refetch on its progress emits.
  // Mirrors the established ProcessingStatus.tsx / CommandInput.tsx pattern; this
  // context was the lone consumer that listened for `progress` without ever
  // joining, so it never received the room-scoped emits (the 5D hang).
  useEffect(() => {
    if (!socket) return;

    // Enter the room now (Socket.IO buffers emits until connected), and re-emit
    // on every (re)connect so a reconnect re-enters the room.
    const join = () => socket.emit("join", jobId);
    join();
    socket.on("connect", join);

    const handleProgress = (data: { jobId?: string }) => {
      if (data.jobId === jobId) refetch();
    };
    socket.on("progress", handleProgress);

    return () => {
      socket.off("connect", join);
      socket.off("progress", handleProgress);
    };
  }, [socket, jobId, refetch]);

  return (
    <JobContext.Provider
      value={{ job, isLoading: query.isLoading, error, refetch: () => void refetch() }}
    >
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
