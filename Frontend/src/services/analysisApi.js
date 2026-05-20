/**
 * Analysis API Service
 *
 * Handles all API calls to the analysis service for post-interview report generation.
 * Provides clean wrapper functions for report operations.
 */

const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:3001";

/**
 * Build a full media URL for interview recordings.
 * @param {string} roomId  - Mongo ObjectId of the CallRoom
 * @param {string} path    - e.g. 'video', 'audio', 'frame/frame_001.jpg'
 */
export function buildMediaUrl(roomId, mediaPath) {
  return `${API_BASE}/api/call-rooms/${roomId}/media/${mediaPath}`;
}

/**
 * Fetch the interview media manifest.
 * Returns { available, interviewId, video, audio, frames, frameCount }
 *
 * @param {string} roomId - Mongo ObjectId of the CallRoom
 */
export async function getInterviewMedia(roomId) {
  const response = await fetch(`${API_BASE}/api/call-rooms/${roomId}/media`, {
    headers: getAuthHeaders(),
  });

  // Check if response is HTML instead of JSON (indicates auth redirect or server error)
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("text/html")) {
    const text = await response.text();
    console.error(
      "[Media API] Received HTML response instead of JSON:",
      text.slice(0, 200),
    );
    throw new Error(
      "Authentication required or server unavailable. Please log in again.",
    );
  }

  // Handle 401 unauthorized
  if (response.status === 401) {
    throw new Error("Session expired. Please log in again to view media.");
  }

  // Handle 404 not found
  if (response.status === 404) {
    return {
      available: false,
      video: { available: false },
      audio: { available: false },
      frames: [],
    };
  }

  // Parse JSON response
  let data;
  try {
    data = await response.json();
  } catch (parseError) {
    const text = await response.text();
    console.error(
      "[Media API] Failed to parse JSON response:",
      parseError,
      text.slice(0, 200),
    );
    throw new Error("Invalid response from server. Please try again.");
  }

  if (!response.ok) {
    throw new Error(
      data.message || data.error || "Failed to fetch media manifest",
    );
  }

  return data;
}

/**
 * Get authentication headers for API requests
 */
const getAuthHeaders = () => {
  const token = localStorage.getItem("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
};

/**
 * Start report analysis for an interview
 *
 * @param {string} interviewId - The interview/room ID
 * @param {boolean} force - Whether to force rerun if already completed
 * @returns {Promise<{success: boolean, jobId?: string, status: string, message?: string, report?: object, error?: object}>}
 */
export async function startReportAnalysis(interviewId, force = false) {
  const response = await fetch(
    `${API_BASE}/api/interviews/${interviewId}/analyze-video`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...getAuthHeaders(),
      },
      body: JSON.stringify({ force }),
    },
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      data.message || data.error?.message || "Failed to start analysis",
    );
  }

  return data;
}

/**
 * Get the current analysis job status
 *
 * @param {string} interviewId - The interview/room ID
 * @returns {Promise<{success: boolean, job?: object}>}
 */
export async function getReportJobStatus(interviewId) {
  const response = await fetch(
    `${API_BASE}/api/interviews/${interviewId}/analysis-status`,
    {
      headers: getAuthHeaders(),
    },
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.message || "Failed to fetch job status");
  }

  return data;
}

/**
 * Get the final analysis report
 *
 * @param {string} interviewId - The interview/room ID
 * @returns {Promise<{success: boolean, report?: object}>}
 */
export async function getInterviewReport(interviewId) {
  const response = await fetch(
    `${API_BASE}/api/interviews/${interviewId}/final-report`,
    {
      headers: getAuthHeaders(),
    },
  );

  const data = await response.json();

  if (!response.ok) {
    if (response.status === 404) {
      return { success: true, report: null };
    }
    throw new Error(data.message || "Failed to fetch report");
  }

  return data;
}

/**
 * Fetch the final report with automatic retry on 404.
 *
 * When the analysis job transitions to "completed", there can be a brief
 * window (MongoDB write propagation, connection pool delays) where GET
 * /final-report returns 404 even though the job is done. This helper
 * retries up to maxRetries times with exponentialBackoffMs before giving up.
 *
 * @param {string} interviewId - The interview/room ID
 * @param {object} options
 * @param {number} options.maxRetries - Number of retry attempts (default 4)
 * @param {number} options.backoffMs - Initial backoff in ms, doubles each retry (default 800)
 * @returns {Promise<{success: boolean, report?: object}>}
 */
export async function getInterviewReportWithRetry(
  interviewId,
  { maxRetries = 4, backoffMs = 800 } = {},
) {
  let lastError = null;
  let delay = backoffMs;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      // Exponential backoff before retrying
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, 10000); // cap at 10s
    }

    try {
      const result = await getInterviewReport(interviewId);
      if (result.report) {
        return result; // success
      }
      // report is null → 404 → retry
      lastError = new Error("Report not available yet (null response)");
    } catch (err) {
      lastError = err;
      // Retry on any error
    }
  }

  // All retries exhausted
  return {
    success: false,
    report: null,
    error: lastError?.message || "Report unavailable after retries",
  };
}

/**
 * Get the integrity report for an interview
 *
 * @param {string} interviewId - The interview/room ID
 * @returns {Promise<{success: boolean, report?: object}>}
 */
export async function getIntegrityReport(interviewId) {
  const response = await fetch(
    `${API_BASE}/api/interviews/${interviewId}/integrity-report`,
    {
      headers: getAuthHeaders(),
    },
  );

  const data = await response.json();

  if (!response.ok) {
    if (response.status === 404) {
      return { success: true, report: null };
    }
    throw new Error(data.message || "Failed to fetch integrity report");
  }

  return data;
}

/**
 * Get optional recruiter-only behavioral overlay data.
 * These are non-deterministic advisory behavioral signals and never affect scoring.
 *
 * @param {string} interviewId - The interview/room ID
 * @returns {Promise<{success: boolean, advisoryOnly: boolean, events?: Array, summary?: object}>}
 */
export async function getBehavioralInsights(interviewId) {
  const response = await fetch(
    `${API_BASE}/api/interviews/${interviewId}/behavioral-insights`,
    {
      headers: getAuthHeaders(),
    },
  );

  if (response.status === 404) {
    return {
      success: true,
      advisoryOnly: true,
      outputLabel: "Non-deterministic advisory behavioral signals",
      available: false,
      events: [],
      summary: null,
    };
  }

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      data.message || data.error?.message || "Behavioral insights unavailable",
    );
  }

  return data;
}

/**
 * Get recruiter-only DeepFace behavioral timeline overlay data.
 * Advisory-only. Returns a fallback shape (ok:false, fallback:true) on any
 * backend issue so the video player can keep working unaffected.
 *
 * @param {string} interviewId
 * @returns {Promise<object>}
 */
export async function getBehavioralTimeline(interviewId) {
  try {
    const response = await fetch(
      `${API_BASE}/api/interviews/${interviewId}/behavioral-timeline`,
      { headers: getAuthHeaders() },
    );
    const data = await response.json().catch(() => ({}));
    if (!data || (data.ok === false && !data.fallback)) {
      return {
        ok: false,
        fallback: true,
        interview_id: interviewId,
        message: "Behavioral overlay unavailable",
      };
    }
    return data;
  } catch (err) {
    console.error("[BehavioralTimeline] fetch failed:", err);
    return {
      ok: false,
      fallback: true,
      interview_id: interviewId,
      message: "Behavioral overlay unavailable",
    };
  }
}

/**
 * Trigger the DeepFace behavioral timeline analysis pipeline.
 * Fire-and-forget; never throws.
 *
 * @param {string} interviewId
 * @returns {Promise<object>}
 */
export async function requestBehavioralTimelineAnalysis(interviewId) {
  try {
    const response = await fetch(
      `${API_BASE}/api/interviews/${interviewId}/behavioral-timeline/analyze`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
      },
    );
    return await response.json().catch(() => ({}));
  } catch (err) {
    console.error("[BehavioralTimeline] analyze trigger failed:", err);
    return {
      ok: false,
      fallback: true,
      interview_id: interviewId,
      message: "Behavioral overlay unavailable",
    };
  }
}

/**
 * Start optional behavioral overlay processing in the background.
 *
 * @param {string} interviewId - The interview/room ID
 * @returns {Promise<object>}
 */
export async function startBehavioralInsightsAnalysis(interviewId) {
  const response = await fetch(
    `${API_BASE}/api/interviews/${interviewId}/behavioral-insights/analyze`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...getAuthHeaders(),
      },
    },
  );

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      data.message ||
        data.error?.message ||
        "Failed to start advisory behavioral insights analysis",
    );
  }

  return data;
}

/**
 * Upload interview video for analysis
 *
 * @param {string} interviewId - The interview/room ID
 * @param {File} file - The video file to upload
 * @returns {Promise<{success: boolean, videoPath?: string}>}
 */
export async function uploadInterviewVideo(interviewId, file) {
  const formData = new FormData();
  formData.append("file", file);

  const response = await fetch(
    `${API_BASE}/api/interviews/${interviewId}/video/upload`,
    {
      method: "POST",
      headers: getAuthHeaders(),
      body: formData,
    },
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.message || data.detail || "Failed to upload video");
  }

  return data;
}

/**
 * Determine report status based on job and report data
 *
 * @param {object|null} job - The job status object
 * @param {object|null} report - The final report object
 * @returns {'none'|'pending'|'running'|'completed'|'failed'}
 */
export function determineReportStatus(job, report) {
  if (!job && !report) return "none";
  if (report && !job) return "completed";
  if (!job) return "none";

  const status = job.status?.toLowerCase();

  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "running" || status === "processing") return "running";
  if (
    status === "uploaded" ||
    status === "pending" ||
    status === "initializing"
  )
    return "pending";

  return "none";
}

/**
 * Format structured error for display
 *
 * @param {object} error - The error object from API
 * @returns {string} Formatted error message
 */
export function formatAnalysisError(error) {
  if (!error) return "An unknown error occurred";

  if (typeof error === "string") return error;

  const { code, message, step } = error;

  if (step && message) {
    return `Analysis failed during ${step}: ${message}`;
  }

  if (code && message) {
    return `${message} (${code})`;
  }

  return message || "Analysis failed";
}

/**
 * Hook for polling analysis status
 *
 * @param {string} interviewId - The interview/room ID
 * @param {function} onStatusChange - Callback when status changes
 * @param {object} options - Polling options
 * @returns {function} Cleanup function to stop polling
 */
export function pollAnalysisStatus(interviewId, onStatusChange, options = {}) {
  const {
    intervalMs = 3000,
    maxAttempts = 200, // ~10 minutes at 3 second intervals
    onError,
    onComplete,
  } = options;

  let attempts = 0;
  let isRunning = true;
  let timeoutId = null;

  const poll = async () => {
    if (!isRunning || attempts >= maxAttempts) {
      if (attempts >= maxAttempts && onError) {
        onError(new Error("Polling timeout - analysis taking too long"));
      }
      return;
    }

    attempts++;

    try {
      const { job } = await getReportJobStatus(interviewId);

      if (!job) {
        if (isRunning) {
          timeoutId = setTimeout(poll, intervalMs);
        }
        return;
      }

      const status = job.status?.toLowerCase();

      onStatusChange({
        status,
        progress: job.progress || 0,
        currentStep: job.currentStep || "unknown",
        job,
      });

      if (status === "completed") {
        if (onComplete) onComplete(job);
        return;
      }

      if (status === "failed") {
        if (onError)
          onError(new Error(job.error?.message || "Analysis failed"));
        return;
      }

      // Continue polling for running/pending states
      if (isRunning) {
        timeoutId = setTimeout(poll, intervalMs);
      }
    } catch (err) {
      if (onError) onError(err);
      // Retry on error unless explicitly stopped
      if (isRunning) {
        timeoutId = setTimeout(poll, intervalMs);
      }
    }
  };

  // Start polling
  poll();

  // Return cleanup function
  return () => {
    isRunning = false;
    if (timeoutId) clearTimeout(timeoutId);
  };
}
