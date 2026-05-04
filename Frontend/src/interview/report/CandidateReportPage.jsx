/**
 * CandidateReportPage.jsx
 *
 * Full recruiter report page assembled from sub-components.
 * Loads the report from the API, handles missing data gracefully,
 * and lets the recruiter submit accept / reject / needs_review.
 *
 * Route: opened inside CallRoomDashboard when detailTab === 'report'
 * Props:
 *   roomId        {string}  MongoDB _id of the CallRoom
 *   room          {object}  CallRoom document (may be partial)
 *   apiBase       {string}  e.g. "http://localhost:3001"
 *   token         {string}  JWT
 *   onClose       {func}    optional back/close handler
 */
import { useState, useEffect, useCallback } from 'react';
import AIRecommendationCard from './AIRecommendationCard';
import ScoreBreakdownCards from './ScoreBreakdownCards';
import TechnicalSkillMatch from './TechnicalSkillMatch';
import QuestionEvaluationTable from './QuestionEvaluationTable';
import VisionIntegritySummary from './VisionIntegritySummary';
import EventTimeline from '../EventTimeline';
import RecruiterDecisionBox from './RecruiterDecisionBox';
import './CandidateReportPage.css';

const MOCK_REPORT_URL = null; // set to a path to force-load mock data

export default function CandidateReportPage({ roomId, room, apiBase, token, onClose }) {
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState('');
  const [source, setSource] = useState('');
  const [decisionSaved, setDecisionSaved] = useState(false);
  const [activeSection, setActiveSection] = useState('overview');

  const authHeaders = { Authorization: `Bearer ${token}` };

  const loadReport = useCallback(async () => {
    if (!roomId) return;
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`${apiBase}/api/call-rooms/${roomId}/report`, { headers: authHeaders });
      const data = await res.json();
      if (data.success && data.report) {
        setReport(data.report);
        setSource(data.source || '');
      } else if (data.source === 'not_ready') {
        setError('The interview has not ended yet. The report will be available once the session closes.');
      }
    } catch {
      setError('Could not load the report. Please try again.');
    } finally {
      setLoading(false);
    }
  }, [roomId, apiBase]);

  useEffect(() => { loadReport(); }, [loadReport]);

  const generateReport = async () => {
    setGenerating(true);
    setError('');
    try {
      const res = await fetch(`${apiBase}/api/call-rooms/${roomId}/generate-report`, {
        method: 'POST',
        headers: authHeaders,
      });
      const data = await res.json();
      if (data.success && data.report) {
        setReport(data.report);
        setSource(data.source || 'generated');
      } else {
        setError(data.message || 'Generation failed.');
      }
    } catch {
      setError('Report generation request failed.');
    } finally {
      setGenerating(false);
    }
  };

  const submitDecision = async (status, notes) => {
    try {
      const res = await fetch(`${apiBase}/api/call-rooms/${roomId}/recruiter-decision`, {
        method: 'PATCH',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, notes }),
      });
      const data = await res.json();
      if (data.success) {
        setReport(prev => prev ? {
          ...prev,
          recruiterDecision: data.decision,
        } : prev);
        setDecisionSaved(true);
        setTimeout(() => setDecisionSaved(false), 3000);
      }
    } catch {
      // silent — user can retry
    }
  };

  const NAV_ITEMS = [
    { id: 'overview', label: '📋 Overview' },
    { id: 'scores', label: '🎯 Scores' },
    { id: 'questions', label: '❓ Questions' },
    { id: 'skills', label: '🔧 Skills' },
    { id: 'communication', label: '💬 Communication' },
    { id: 'vision', label: '👁 Integrity' },
    { id: 'notes', label: '🤖 AI Notes' },
    { id: 'decision', label: '✅ Decision' },
  ];

  if (loading) {
    return (
      <div className="crp-loading">
        <div className="crp-spinner" />
        <p>Loading recruiter report…</p>
      </div>
    );
  }

  if (!report && error) {
    return (
      <div className="crp-error-state">
        <div className="crp-error-icon">📄</div>
        <h3>Report Not Available</h3>
        <p>{error}</p>
        <div className="crp-error-actions">
          <button className="crp-btn crp-btn--primary" onClick={generateReport} disabled={generating}>
            {generating ? 'Generating…' : '⚡ Generate Report'}
          </button>
          <button className="crp-btn crp-btn--ghost" onClick={loadReport}>🔄 Retry</button>
        </div>
      </div>
    );
  }

  if (!report) {
    return (
      <div className="crp-error-state">
        <div className="crp-error-icon">📄</div>
        <h3>No Report Yet</h3>
        <p>Generate the recruiter report once the interview has ended.</p>
        <button className="crp-btn crp-btn--primary" onClick={generateReport} disabled={generating}>
          {generating ? 'Generating…' : '⚡ Generate Report'}
        </button>
      </div>
    );
  }

  const { candidateInfo, finalRecommendation, scoreBreakdown, questionEvaluations,
          technicalAnalysis, communicationAnalysis, visionIntegrityReport,
          aiInterviewerNotes, recruiterDecision } = report;

  const visionEvents = room?.integrityEvents || room?.visionMonitoring?.events || [];

  return (
    <div className="crp-root">
      {/* ── Header ── */}
      <div className="crp-header">
        <div className="crp-header-left">
          {onClose && (
            <button className="crp-back-btn" onClick={onClose} title="Back to dashboard">
              ← Back
            </button>
          )}
          <div>
            <h2 className="crp-title">Recruiter Report</h2>
            <p className="crp-subtitle">
              {candidateInfo?.candidateName || 'Unknown Candidate'} · {candidateInfo?.jobTitle || 'N/A'}
            </p>
          </div>
        </div>
        <div className="crp-header-right">
          {source === 'mock' && (
            <span className="crp-badge crp-badge--warn">⚠ Demo Data</span>
          )}
          <button
            className="crp-btn crp-btn--ghost crp-btn--sm"
            onClick={generateReport}
            disabled={generating}
          >
            {generating ? 'Regenerating…' : '🔄 Regenerate'}
          </button>
        </div>
      </div>

      {decisionSaved && (
        <div className="crp-toast crp-toast--success">✅ Decision saved successfully.</div>
      )}

      <div className="crp-layout">
        {/* ── Side Nav ── */}
        <nav className="crp-sidenav">
          {NAV_ITEMS.map(item => (
            <button
              key={item.id}
              className={`crp-nav-btn ${activeSection === item.id ? 'active' : ''}`}
              onClick={() => setActiveSection(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>

        {/* ── Main Content ── */}
        <main className="crp-main">
          {/* ─ Overview ─ */}
          {activeSection === 'overview' && (
            <div className="crp-section">
              <AIRecommendationCard recommendation={finalRecommendation} candidateInfo={candidateInfo} />

              {/* Candidate info card */}
              <div className="crp-info-grid">
                {[
                  { label: 'Candidate', value: candidateInfo?.candidateName },
                  { label: 'Position', value: candidateInfo?.jobTitle },
                  { label: 'Interview Date', value: candidateInfo?.interviewDate
                    ? new Date(candidateInfo.interviewDate).toLocaleDateString() : 'N/A' },
                  { label: 'Duration', value: candidateInfo?.duration },
                  { label: 'Status', value: candidateInfo?.interviewStatus },
                  { label: 'Overall Score', value: `${finalRecommendation?.overallScore ?? '–'} / 100` },
                ].map(item => (
                  <div className="crp-info-item" key={item.label}>
                    <span className="crp-info-label">{item.label}</span>
                    <span className="crp-info-value">{item.value || '–'}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ─ Scores ─ */}
          {activeSection === 'scores' && (
            <div className="crp-section">
              <h3 className="crp-section-title">Score Breakdown</h3>
              <ScoreBreakdownCards scores={scoreBreakdown} />
            </div>
          )}

          {/* ─ Questions ─ */}
          {activeSection === 'questions' && (
            <div className="crp-section">
              <h3 className="crp-section-title">Question-by-Question Evaluation</h3>
              <QuestionEvaluationTable evaluations={questionEvaluations} />
            </div>
          )}

          {/* ─ Skills ─ */}
          {activeSection === 'skills' && (
            <div className="crp-section">
              <h3 className="crp-section-title">Technical Skills Analysis</h3>
              <TechnicalSkillMatch analysis={technicalAnalysis} />
            </div>
          )}

          {/* ─ Communication ─ */}
          {activeSection === 'communication' && (
            <div className="crp-section">
              <h3 className="crp-section-title">Communication Analysis</h3>
              <div className="crp-comm-grid">
                {[
                  { label: 'Clarity', value: communicationAnalysis?.clarity },
                  { label: 'Relevance', value: communicationAnalysis?.relevance },
                  { label: 'Structure', value: communicationAnalysis?.structure },
                  { label: 'Completeness', value: communicationAnalysis?.completeness },
                  { label: 'Examples Quality', value: communicationAnalysis?.examplesQuality },
                ].map(item => (
                  <div className="crp-comm-item" key={item.label}>
                    <span className="crp-comm-label">{item.label}</span>
                    <span className="crp-comm-value">{item.value || '–'}</span>
                  </div>
                ))}
              </div>
              <div className="crp-comm-score">
                Communication Score: <strong>{communicationAnalysis?.score ?? '–'} / 20</strong>
              </div>
              {communicationAnalysis?.summary && (
                <p className="crp-comm-summary">{communicationAnalysis.summary}</p>
              )}
            </div>
          )}

          {/* ─ Vision Integrity ─ */}
          {activeSection === 'vision' && (
            <div className="crp-section">
              <h3 className="crp-section-title">Vision Integrity Report</h3>
              <p className="crp-disclaimer">
                ⚠️ These are objective visual signals only. They do not infer cheating, emotion, honesty, or personality.
                The recruiter is the final decision-maker.
              </p>
              <VisionIntegritySummary visionReport={visionIntegrityReport} />
              <div style={{ marginTop: '24px' }}>
                <h4 className="crp-sub-title">Event Timeline</h4>
                <EventTimeline events={visionEvents} />
              </div>
            </div>
          )}

          {/* ─ AI Notes ─ */}
          {activeSection === 'notes' && (
            <div className="crp-section">
              <h3 className="crp-section-title">AI Interviewer Notes</h3>
              <p className="crp-disclaimer">
                These are AI-generated observations based solely on transcript content. They are not a hiring decision.
              </p>
              <div className="crp-ai-notes">
                <div className="crp-note-block">
                  <h4>Interview Summary</h4>
                  <p>{aiInterviewerNotes?.summary || 'No summary available.'}</p>
                </div>
                <div className="crp-note-cols">
                  <div className="crp-note-col crp-note-col--green">
                    <h4>Strengths Observed</h4>
                    {(aiInterviewerNotes?.strengths || []).length > 0
                      ? <ul>{(aiInterviewerNotes.strengths).map((s, i) => <li key={i}>{s}</li>)}</ul>
                      : <p className="crp-note-empty">None identified.</p>
                    }
                  </div>
                  <div className="crp-note-col crp-note-col--amber">
                    <h4>Areas to Explore</h4>
                    {(aiInterviewerNotes?.weaknesses || []).length > 0
                      ? <ul>{(aiInterviewerNotes.weaknesses).map((s, i) => <li key={i}>{s}</li>)}</ul>
                      : <p className="crp-note-empty">None identified.</p>
                    }
                  </div>
                </div>
                <div className="crp-note-block">
                  <h4>Recommended Follow-up Questions</h4>
                  {(aiInterviewerNotes?.recommendedFollowUpQuestions || []).length > 0
                    ? <ul>{(aiInterviewerNotes.recommendedFollowUpQuestions).map((q, i) => <li key={i}>{q}</li>)}</ul>
                    : <p className="crp-note-empty">No follow-up questions generated.</p>
                  }
                </div>
              </div>
            </div>
          )}

          {/* ─ Decision ─ */}
          {activeSection === 'decision' && (
            <div className="crp-section">
              <h3 className="crp-section-title">Recruiter Decision</h3>
              <p className="crp-disclaimer">
                ⚠️ The AI must not and does not automatically reject any candidate.
                All hiring decisions are made by the recruiter.
              </p>
              <RecruiterDecisionBox
                currentDecision={recruiterDecision}
                recommendation={finalRecommendation}
                onSubmit={submitDecision}
              />
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
