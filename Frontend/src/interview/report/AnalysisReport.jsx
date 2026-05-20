/**
 * AnalysisReport.jsx
 *
 * Complete analysis report view with status panel, overview, metrics, and evaluations.
 * Integrates with the analysis service API for report generation and polling.
 */
import { useState, useEffect, useCallback, useRef } from "react";
import AnalysisStatusPanel from "./AnalysisStatusPanel";
import CandidateSnapshotPanel from "./CandidateSnapshotPanel";
import InterviewMediaPanel from "./InterviewMediaPanel";
import SkillsEvidencePanel from "./SkillsEvidencePanel";
import QuestionEvaluationPanel from "./QuestionEvaluationPanel";
import CommunicationSignalsPanel from "./CommunicationSignalsPanel";
import JobMatchAnalysisPanel from "./JobMatchAnalysisPanel";
import IntegrityTrustPanel from "./IntegrityTrustPanel";
import RecruiterActionsPanel from "./RecruiterActionsPanel";
import TechnicalMetadataPanel from "./TechnicalMetadataPanel";
import {
  getInterviewReport,
  getInterviewReportWithRetry,
  getReportJobStatus,
  pollAnalysisStatus,
  determineReportStatus,
} from "../../services/analysisApi";
import "./AnalysisReport.css";

export default function AnalysisReport({
  interviewId,
  room,
  roomId, // Mongo _id of the CallRoom — used for media URLs
  initialReport = null,
  initialJob = null,
}) {
  // Derive the media roomId: prefer explicit prop, fall back to room._id
  const mediaRoomId = roomId || room?._id || null;
  const [report, setReport] = useState(initialReport);
  const [job, setJob] = useState(initialJob);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const pollCleanupRef = useRef(null);

  // Fetch report from API.
  // Uses getInterviewReportWithRetry when called after job completion so that
  // a brief MongoDB propagation delay (the "just-completed" 404 race) doesn't
  // leave the recruiter staring at an empty page.
  const fetchReport = useCallback(
    async ({ withRetry = false } = {}) => {
      if (!interviewId) return;

      setIsLoading(true);
      setError(null);

      try {
        const result = withRetry
          ? await getInterviewReportWithRetry(interviewId)
          : await getInterviewReport(interviewId);
        if (result.report) {
          setReport(result.report);
        } else if (withRetry && result.error) {
          // All retries exhausted — surface a friendly error.
          setError(
            "Report generation completed but the report could not be loaded. " +
              "Please refresh the page or contact support.",
          );
        }
      } catch (err) {
        setError(err.message || "Failed to fetch report");
      } finally {
        setIsLoading(false);
      }
    },
    [interviewId],
  );

  // Fetch job status
  const fetchJobStatus = useCallback(async () => {
    if (!interviewId) return;

    try {
      const result = await getReportJobStatus(interviewId);
      if (result.job) {
        setJob(result.job);
      }
    } catch (err) {
      // Silently fail - job might not exist yet
      console.debug("Job status fetch failed:", err);
    }
  }, [interviewId]);

  // Handle status change from polling or actions
  const handleStatusChange = useCallback(
    (statusUpdate) => {
      setJob((prev) => ({
        ...prev,
        ...statusUpdate,
      }));

      // If completed, fetch the report with retry to handle the
      // brief window between job-completion and MongoDB read visibility.
      if (statusUpdate.status === "completed") {
        fetchReport({ withRetry: true });
      }
    },
    [fetchReport],
  );

  // Handle report generated
  const handleReportGenerated = useCallback((newReport) => {
    setReport(newReport);
  }, []);

  // Start polling when analysis is running
  useEffect(() => {
    // Don't poll if we already have a report
    if (report) {
      return;
    }

    const status = determineReportStatus(job, report);

    if (status === "running" || status === "pending") {
      // Start polling
      pollCleanupRef.current = pollAnalysisStatus(
        interviewId,
        handleStatusChange,
        {
          intervalMs: 3000,
          maxAttempts: 200,
          onComplete: () => {
            fetchReport({ withRetry: true });
          },
          onError: (err) => {
            setError(err.message);
          },
        },
      );
    }

    return () => {
      if (pollCleanupRef.current) {
        pollCleanupRef.current();
        pollCleanupRef.current = null;
      }
    };
  }, [interviewId, job, report, handleStatusChange, fetchReport]);

  // Initial fetch
  useEffect(() => {
    if (!initialReport) {
      fetchReport();
    }
    if (!initialJob) {
      fetchJobStatus();
    }
  }, [fetchReport, fetchJobStatus, initialReport, initialJob]);

  const handleRetry = () => {
    setError(null);
    fetchReport();
    fetchJobStatus();
  };
  const reportStatus = determineReportStatus(job, report);
  const showStatusPanel =
    !report ||
    reportStatus === "running" ||
    reportStatus === "pending" ||
    reportStatus === "failed";

  if (isLoading && !report && !job) {
    return (
      <div className="analysis-report analysis-report--loading">
        <div className="analysis-report__spinner" />
        <p>Loading analysis report...</p>
      </div>
    );
  }

  if (error && !report) {
    return (
      <div className="analysis-report analysis-report--error">
        <div className="analysis-error-display">
          <span className="analysis-error-display__icon">⚠️</span>
          <h3 className="analysis-error-display__title">
            Error Loading Report
          </h3>
          <p className="analysis-error-display__message">{error}</p>
          <button
            className="analysis-error-display__retry"
            onClick={handleRetry}
          >
            🔄 Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="analysis-report">
      {showStatusPanel && (
        <AnalysisStatusPanel
          interviewId={interviewId}
          job={job}
          report={report}
          onStatusChange={handleStatusChange}
          onReportGenerated={handleReportGenerated}
        />
      )}

      {/* Recruiter Executive Report — Clean Information Flow */}
      {report && (
        <>
          {/* 2. CANDIDATE SNAPSHOT — Key candidate info at a glance */}
          <CandidateSnapshotPanel report={report} room={room} />

          {/* 3. INTERVIEW REPLAY — Media for review */}
          {mediaRoomId && (
            <InterviewMediaPanel
              roomId={mediaRoomId}
              report={report}
              room={room}
            />
          )}

          {/* Behavioral Timeline & DeepFace Emotion Dashboard removed.
              The new in-video LocalEmotionSummary (inside InterviewMediaPanel)
              replaces both — driven by MediaPipe blendshape samples computed
              live from the recorded video, with no stale server-cached data. */}

          {/* 4. SKILLS & TECHNICAL EVIDENCE — What candidate demonstrated */}
          <SkillsEvidencePanel report={report} job={job} room={room} />

          {/* 5. QUESTION-BY-QUESTION REVIEW — Detailed Q&A analysis */}
          <QuestionEvaluationPanel report={report} />

          {/* 6. COMMUNICATION & HR SIGNALS — Soft skills assessment */}
          <CommunicationSignalsPanel report={report} />

          {/* 7. JOB MATCH ANALYSIS — Fit for the role */}
          <JobMatchAnalysisPanel report={report} job={job} />

          {/* 8. INTEGRITY & TRUST — Interview reliability */}
          <IntegrityTrustPanel report={report} />

          {/* 9. RECOMMENDED RECRUITER ACTIONS — Clear next steps */}
          <RecruiterActionsPanel report={report} />

          {/* 10. TECHNICAL METADATA — Collapsed engineering details */}
          <TechnicalMetadataPanel report={report} job={job} />
        </>
      )}

      {/* No report yet message */}
      {!report && !isLoading && (
        <div className="analysis-report__empty">
          <div className="empty-state">
            <span className="empty-state__icon">📊</span>
            <h3 className="empty-state__title">No Report Available</h3>
            <p className="empty-state__text">
              Generate a report to see detailed analysis including scores,
              integrity metrics, and recommendations.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
