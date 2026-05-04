/**
 * Recruiter Integrity Report Component
 * 
 * Main component for displaying interview integrity reports to recruiters.
 * Includes objective visual signals, timeline, and interview comfort indicators.
 * 
 * SAFETY: Does NOT show emotion detection, stress inference, or personality analysis.
 * Only objective visual signals for recruiter review.
 */

import React, { useState, useEffect } from 'react';
import VisionSignalCards from './VisionSignalCards';
import EventTimeline from './EventTimeline';
import './RecruiterIntegrityReport.css';

const RecruiterIntegrityReport = ({ interviewId, apiBase, token }) => {
  const [report, setReport] = useState(null);
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showMock, setShowMock] = useState(false);

  useEffect(() => {
    if (!interviewId || !apiBase) {
      setLoading(false);
      return;
    }

    const fetchReport = async () => {
      try {
        setLoading(true);
        setError(null);

        const response = await fetch(
          `${apiBase}/api/interviews/${interviewId}/integrity-report${showMock ? '?mock=true' : ''}`,
          {
            headers: {
              'Authorization': `Bearer ${token}`,
            },
          }
        );

        if (!response.ok) {
          throw new Error(`Failed to fetch report: ${response.status}`);
        }

        const data = await response.json();
        
        if (data.success) {
          setReport(data.report);
          setEvents(data.events || []);
        } else {
          throw new Error(data.message || 'Failed to load report');
        }
      } catch (err) {
        setError(err.message);
        console.error('Integrity report fetch error:', err);
      } finally {
        setLoading(false);
      }
    };

    fetchReport();
  }, [interviewId, apiBase, token, showMock]);

  if (loading) {
    return (
      <div className="integrity-report integrity-report--loading">
        <div className="integrity-report__spinner">Loading integrity report...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="integrity-report integrity-report--error">
        <div className="integrity-report__error">
          <p>Failed to load integrity report</p>
          <p className="integrity-report__error-detail">{error}</p>
        </div>
      </div>
    );
  }

  if (!report) {
    return (
      <div className="integrity-report integrity-report--empty">
        <p>No integrity report available for this interview.</p>
        <button 
          className="integrity-report__mock-btn"
          onClick={() => setShowMock(true)}
        >
          View Mock Report
        </button>
      </div>
    );
  }

  const riskLevel = report.overallIntegrityRisk || report.overallRiskLevel || report.integrityRisk?.level || 'low';
  const riskScore = report.riskScore || report.integrityRisk?.score || 0;
  
  // Use report's interviewComfortIndicators if available, otherwise calculate
  const reportComfortIndicators = report?.interviewComfortIndicators;
  const calculatedComfortIndicators = calculateComfortIndicators(report, events);
  
  // Merge report values with calculated fallbacks
  const comfortIndicators = {
    attentionConsistency: reportComfortIndicators?.attentionConsistency || calculatedComfortIndicators.attentionConsistency,
    cameraStability: reportComfortIndicators?.cameraStability || calculatedComfortIndicators.cameraStability,
    interviewPressureIndicator: reportComfortIndicators?.interviewPressureIndicator || calculatedComfortIndicators.pressureLevel,
    pressureExplanation: reportComfortIndicators?.pressureExplanation || calculatedComfortIndicators.pressureExplanation,
    importantLimitation: reportComfortIndicators?.importantLimitation || calculatedComfortIndicators.importantLimitation,
    facePresencePercentage: report?.objectiveVisualSignals?.facePresencePercentage || calculatedComfortIndicators.facePresencePercentage,
    lookingAwayTotalSeconds: report?.objectiveVisualSignals?.lookingAwayTotalSeconds || calculatedComfortIndicators.lookingAwayTotalSeconds,
  };

  return (
    <div className={`integrity-report integrity-report--${riskLevel}`}>
      {/* Header */}
      <div className="integrity-report__header">
        <h2 className="integrity-report__title">Interview Integrity Report</h2>
        <div className={`integrity-report__risk integrity-report__risk--${riskLevel}`}>
          <span className="integrity-report__risk-label">Risk Level</span>
          <span className="integrity-report__risk-value">{riskLevel.toUpperCase()}</span>
          <span className="integrity-report__risk-score">({riskScore}/100)</span>
        </div>
      </div>

      {/* Important Notice */}
      <div className="integrity-report__notice">
        <strong>⚠️ Important:</strong> This report contains objective visual signals only. 
        It does <strong>not</strong> detect emotion, stress, honesty, personality, identity, 
        or mental state. The recruiter remains the final decision-maker.
      </div>

      {/* Summary */}
      <div className="integrity-report__summary">
        <h3 className="integrity-report__section-title">Summary</h3>
        <p>{report.summary || 'No significant integrity signals detected.'}</p>
      </div>

      {/* Key Findings */}
      {report.keyFindings && report.keyFindings.length > 0 && (
        <div className="integrity-report__findings">
          <h3 className="integrity-report__section-title">Key Findings</h3>
          <ul>
            {report.keyFindings.map((finding, index) => (
              <li key={index}>{finding}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Objective Visual Signals */}
      <VisionSignalCards report={report} events={events} />

      {/* Interview Comfort Indicators (Objective Only) */}
      <div className="integrity-report__comfort">
        <h3 className="integrity-report__section-title">Interview Comfort Indicators</h3>
        <p className="integrity-report__comfort-disclaimer">
          These are <strong>objective technical indicators</strong> only - not emotion detection.
        </p>
        
        <div className="comfort-grid">
          <div className="comfort-item">
            <span className="comfort-item__label">Attention Consistency</span>
            <span className={`comfort-item__value comfort-item__value--${comfortIndicators.attentionConsistency}`}>
              {comfortIndicators.attentionConsistency}
            </span>
          </div>
          <div className="comfort-item">
            <span className="comfort-item__label">Camera Stability</span>
            <span className={`comfort-item__value comfort-item__value--${comfortIndicators.cameraStability}`}>
              {comfortIndicators.cameraStability}
            </span>
          </div>
          <div className="comfort-item">
            <span className="comfort-item__label">Face Presence</span>
            <span className="comfort-item__value">{comfortIndicators.facePresencePercentage}%</span>
          </div>
          <div className="comfort-item">
            <span className="comfort-item__label">Looking Away</span>
            <span className="comfort-item__value">{formatDuration(comfortIndicators.lookingAwayTotalSeconds)}</span>
          </div>
        </div>

        {/* Interview Pressure Indicator (Experimental) */}
        <div className="pressure-indicator">
          <div className="pressure-indicator__header">
            <span className="pressure-indicator__label">Interview Pressure Indicator</span>
            <span className={`pressure-indicator__value pressure-indicator__value--${comfortIndicators.pressureLevel}`}>
              {comfortIndicators.pressureLevel.toUpperCase()}
            </span>
          </div>
          <p className="pressure-indicator__explanation">
            {comfortIndicators.pressureExplanation}
          </p>
          <p className="pressure-indicator__warning">
            <strong>⚠️ {comfortIndicators.importantLimitation || "This is not emotion detection and must not be used as an automatic hiring decision."}</strong>
          </p>
        </div>
      </div>

      {/* Event Timeline */}
      <EventTimeline events={events} />

      {/* Recruiter Recommendation */}
      <div className="integrity-report__recommendation">
        <h3 className="integrity-report__section-title">Recruiter Recommendation</h3>
        <p>{report.recruiterRecommendation || 'Review the interview normally.'}</p>
      </div>

      {/* Limitations */}
      <div className="integrity-report__limitations">
        <h3 className="integrity-report__section-title">Limitations</h3>
        <p>{report.limitations || 'This system detects objective visual signals only. It may be affected by camera quality, lighting, and network conditions.'}</p>
      </div>

      {/* Generated At */}
      {report.generatedAt && (
        <div className="integrity-report__meta">
          Report generated: {new Date(report.generatedAt).toLocaleString()}
          {report.llmProvider && (
            <span className="integrity-report__provider"> (Provider: {report.llmProvider})</span>
          )}
        </div>
      )}
    </div>
  );
};

/**
 * Calculate objective comfort indicators (NOT emotion detection)
 */
function calculateComfortIndicators(report, events) {
  const metrics = report?.metrics || {};
  
  // Face presence percentage
  const facePresencePercentage = metrics.facePresencePercentage || 0;
  
  // Looking away time
  const lookingAwayTotalSeconds = metrics.lookingAwayTotalSeconds || 0;
  
  // Count camera stability events (unstable frames)
  const unstableEvents = events.filter(e => 
    e.type === 'CAMERA_BLOCKED' || e.type === 'NO_FACE' || e.type === 'NO_FACE_DETECTED'
  ).length;
  
  // Determine attention consistency based on face presence and looking away
  let attentionConsistency = 'high';
  if (facePresencePercentage < 50 || lookingAwayTotalSeconds > 60) {
    attentionConsistency = 'low';
  } else if (facePresencePercentage < 80 || lookingAwayTotalSeconds > 20) {
    attentionConsistency = 'medium';
  }
  
  // Camera stability
  const cameraStability = unstableEvents > 5 ? 'unstable' : 'stable';
  
  // Interview pressure indicator (objective signals only)
  let pressureScore = 0;
  if (facePresencePercentage < 70) pressureScore += 1;
  if (lookingAwayTotalSeconds > 30) pressureScore += 1;
  if (unstableEvents > 3) pressureScore += 1;
  if (metrics.noFaceTotalSeconds > 20) pressureScore += 1;
  if (events.filter(e => e.type === 'TAB_SWITCH').length > 2) pressureScore += 1;
  
  let pressureLevel = 'low';
  let pressureExplanation = 'The interview had consistent camera presence and stable conditions.';
  
  if (pressureScore >= 4) {
    pressureLevel = 'high';
    pressureExplanation = 'The interview had repeated camera absences, multiple tab switches, or extended looking-away periods. This should not be interpreted as stress or performance quality.';
  } else if (pressureScore >= 2) {
    pressureLevel = 'medium';
    pressureExplanation = 'The interview had some camera stability issues or occasional tab switches. This should not be interpreted as stress or performance quality.';
  }
  
  return {
    attentionConsistency,
    cameraStability,
    facePresencePercentage,
    lookingAwayTotalSeconds,
    pressureLevel,
    pressureExplanation,
    importantLimitation: 'This is not emotion detection and must not be used as an automatic hiring decision.',
  };
}

function formatDuration(seconds) {
  if (!seconds || seconds <= 0) return '0s';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
}

export default RecruiterIntegrityReport;
