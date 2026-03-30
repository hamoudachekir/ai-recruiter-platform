import React, { useEffect, useState } from 'react';
import axios from 'axios';
import './QuizAuditLog.css';

const QuizAuditLog = () => {
  const [submissions, setSubmissions] = useState([]);
  const [filteredSubmissions, setFilteredSubmissions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchCandidate, setSearchCandidate] = useState('');
  const [filterFlagged, setFilterFlagged] = useState(false);
  const [filterDateFrom, setFilterDateFrom] = useState('');
  const [filterDateTo, setFilterDateTo] = useState('');
  const [selectedSubmission, setSelectedSubmission] = useState(null);
  const [sortBy, setSortBy] = useState('submittedAt');

  // Fetch All Quiz Submissions
  useEffect(() => {
    const fetchSubmissions = async () => {
      try {
        setLoading(true);
        // Note: This endpoint needs to be created in backend to fetch all submissions
        // For now, we'll fetch from QuizResultModel
        const response = await axios.get('http://localhost:3001/api/quiz-audit-log', {
          headers: { Authorization: `Bearer ${localStorage.getItem('token')}` },
        });
        setSubmissions(response.data || []);
      } catch (error) {
        console.error('❌ Error fetching audit log:', error);
        alert('Failed to load audit data');
      } finally {
        setLoading(false);
      }
    };

    fetchSubmissions();
  }, []);

  // Apply Filters
  useEffect(() => {
    let filtered = [...submissions];

    // Filter by candidate name
    if (searchCandidate.trim()) {
      filtered = filtered.filter(
        (sub) =>
          sub?.candidateId?.name?.toLowerCase().includes(searchCandidate.toLowerCase()) ||
          sub?.candidateId?.email?.toLowerCase().includes(searchCandidate.toLowerCase())
      );
    }

    // Filter by flagged status
    if (filterFlagged) {
      filtered = filtered.filter((sub) => sub?.submissionValidation?.flagged);
    }

    // Filter by date range
    if (filterDateFrom) {
      const fromDate = new Date(filterDateFrom);
      filtered = filtered.filter((sub) => new Date(sub?.submittedAt) >= fromDate);
    }
    if (filterDateTo) {
      const toDate = new Date(filterDateTo);
      toDate.setHours(23, 59, 59, 999);
      filtered = filtered.filter((sub) => new Date(sub?.submittedAt) <= toDate);
    }

    // Sort
    filtered.sort((a, b) => {
      if (sortBy === 'submittedAt') {
        return new Date(b.submittedAt) - new Date(a.submittedAt);
      } else if (sortBy === 'score') {
        return b.score - a.score;
      } else if (sortBy === 'flagged') {
        return (b.submissionValidation?.flagged ? 1 : 0) - (a.submissionValidation?.flagged ? 1 : 0);
      }
      return 0;
    });

    setFilteredSubmissions(filtered);
  }, [submissions, searchCandidate, filterFlagged, filterDateFrom, filterDateTo, sortBy]);

  // Helper: Format Date
  const formatDate = (date) => new Date(date).toLocaleString();

  // Helper: Get Risk Level Badge
  const getRiskLevel = (submission) => {
    const validation = submission?.submissionValidation;
    const flags = submission?.submissionFlags?.length || 0;

    if (flags > 2) return { color: 'red', label: 'HIGH RISK' };
    if (flags === 2) return { color: 'orange', label: 'MEDIUM RISK' };
    if (flags === 1) return { color: 'yellow', label: 'LOW RISK' };
    return { color: 'green', label: 'NORMAL' };
  };

  // Helper: Get Flag Details
  const getFlagDescription = (flag) => {
    const descriptions = {
      'fast-completion': 'Completed suspiciously fast',
      'multiple-focus-losses': 'Multiple tab/window switches',
      'copy-paste-attempts': 'Copy/paste attempts detected',
      'devtools-access': 'DevTools was accessed',
      'suspicious-pattern': 'Unusual answer patterns',
    };
    return descriptions[flag] || flag;
  };

  // Export to CSV
  const handleExportCSV = () => {
    const headers = ['Candidate', 'Email', 'Score', 'Time (sec)', 'Flagged', 'Flags', 'Submitted At', 'IP Address'];
    const rows = filteredSubmissions.map((sub) => [
      sub?.candidateId?.name || 'Unknown',
      sub?.candidateId?.email || 'Unknown',
      sub?.score || 0,
      sub?.timeSpentSeconds || 0,
      sub?.submissionValidation?.flagged ? 'Yes' : 'No',
      (sub?.submissionFlags?.map((f) => f.flag) || []).join('; '),
      formatDate(sub?.submittedAt),
      sub?.auditTrail?.ipAddress || 'Unknown',
    ]);

    const csvContent = [
      headers.join(','),
      ...rows.map((row) => row.map((cell) => `"${cell}"`).join(',')),
    ].join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `quiz-audit-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
  };

  return (
    <div className="audit-log-container">
      <h1>📊 Quiz Submission Audit Log</h1>

      {/* Filters Section */}
      <div className="filters-section">
        <div className="filter-group">
          <input
            type="text"
            placeholder="Search by candidate name or email..."
            value={searchCandidate}
            onChange={(e) => setSearchCandidate(e.target.value)}
            className="search-input"
          />
        </div>

        <div className="filter-group">
          <label>
            <input
              type="checkbox"
              checked={filterFlagged}
              onChange={(e) => setFilterFlagged(e.target.checked)}
            />
            Flagged Only
          </label>
        </div>

        <div className="filter-group">
          <label>From:</label>
          <input
            type="date"
            value={filterDateFrom}
            onChange={(e) => setFilterDateFrom(e.target.value)}
          />
        </div>

        <div className="filter-group">
          <label>To:</label>
          <input
            type="date"
            value={filterDateTo}
            onChange={(e) => setFilterDateTo(e.target.value)}
          />
        </div>

        <div className="filter-group">
          <label>Sort By:</label>
          <select value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
            <option value="submittedAt">Date (Newest)</option>
            <option value="score">Score</option>
            <option value="flagged">Flags</option>
          </select>
        </div>

        <button onClick={handleExportCSV} className="btn-export">
          📥 Export to CSV
        </button>
      </div>

      {/* Submissions Table */}
      {loading ? (
        <div className="loading">Loading audit data...</div>
      ) : filteredSubmissions.length === 0 ? (
        <div className="no-data">No submissions found</div>
      ) : (
        <div className="submissions-table-wrapper">
          <table className="submissions-table">
            <thead>
              <tr>
                <th>Risk</th>
                <th>Candidate</th>
                <th>Score</th>
                <th>Time</th>
                <th>Focus Losses</th>
                <th>Total Flags</th>
                <th>Submitted</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {filteredSubmissions.map((submission, index) => {
                const risk = getRiskLevel(submission);
                return (
                  <tr key={submission._id || index} className={submission?.submissionValidation?.flagged ? 'flagged-row' : ''}>
                    <td>
                      <span className={`risk-badge risk-${risk.color}`}>{risk.label}</span>
                    </td>
                    <td>
                      <strong>{submission?.candidateId?.name || 'Unknown'}</strong>
                      <br />
                      <small>{submission?.candidateId?.email || 'No email'}</small>
                    </td>
                    <td className="score-cell">
                      {submission?.score} / {submission?.totalQuestions}
                      <br />
                      <small>{((submission?.score / Math.max(1, submission?.totalQuestions)) * 100).toFixed(0)}%</small>
                    </td>
                    <td>{submission?.timeSpentSeconds}s</td>
                    <td className="focus-cell">
                      {submission?.auditTrail?.focusEvents?.length || 0}
                      {(submission?.auditTrail?.focusEvents?.length || 0) > 3 && <span className="warning">⚠️</span>}
                    </td>
                    <td className="flags-cell">
                      <strong>{submission?.submissionFlags?.length || 0}</strong>
                      {submission?.submissionFlags?.length > 0 && (
                        <small className="flag-list">
                          {submission.submissionFlags
                            .slice(0, 2)
                            .map((f) => f.flag)
                            .join(', ')}
                          {submission.submissionFlags?.length > 2 && ` +${submission.submissionFlags.length - 2}`}
                        </small>
                      )}
                    </td>
                    <td className="date-cell">
                      <small>{formatDate(submission?.submittedAt)}</small>
                    </td>
                    <td>
                      <button
                        className="btn-details"
                        onClick={() => setSelectedSubmission(submission)}
                      >
                        View
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Details Modal */}
      {selectedSubmission && (
        <div className="modal-overlay" onClick={() => setSelectedSubmission(null)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>📋 Submission Details</h2>
              <button className="btn-close" onClick={() => setSelectedSubmission(null)}>
                ✕
              </button>
            </div>

            <div className="modal-body">
              {/* Basic Info */}
              <section className="detail-section">
                <h3>Candidate Information</h3>
                <p>
                  <strong>Name:</strong> {selectedSubmission?.candidateId?.name || 'Unknown'}
                </p>
                <p>
                  <strong>Email:</strong> {selectedSubmission?.candidateId?.email || 'Unknown'}
                </p>
              </section>

              {/* Performance */}
              <section className="detail-section">
                <h3>Performance</h3>
                <p>
                  <strong>Score:</strong> {selectedSubmission?.score} / {selectedSubmission?.totalQuestions} (
                  {((selectedSubmission?.score / Math.max(1, selectedSubmission?.totalQuestions)) * 100).toFixed(0)}%)
                </p>
                <p>
                  <strong>Time Spent:</strong> {selectedSubmission?.timeSpentSeconds}s
                </p>
                <p>
                  <strong>Submitted At:</strong> {formatDate(selectedSubmission?.submittedAt)}
                </p>
              </section>

              {/* Audit Trail */}
              <section className="detail-section">
                <h3>🔒 Audit Trail</h3>
                <p>
                  <strong>IP Address:</strong> {selectedSubmission?.auditTrail?.ipAddress || 'Unknown'}
                </p>
                <p>
                  <strong>User Agent:</strong>
                  <br />
                  <small>{selectedSubmission?.auditTrail?.userAgent || 'Unknown'}</small>
                </p>
              </section>

              {/* Focus Events */}
              {selectedSubmission?.auditTrail?.focusEvents?.length > 0 && (
                <section className="detail-section">
                  <h3>📍 Focus Events ({selectedSubmission.auditTrail.focusEvents.length})</h3>
                  <div className="event-list">
                    {selectedSubmission.auditTrail.focusEvents.map((event, idx) => (
                      <div key={idx} className="event-item">
                        <span className={`event-type event-${event.type}`}>{event.type}</span>
                        <span className="event-time">{formatDate(event.timestamp)}</span>
                        {event.durationSeconds > 0 && (
                          <span className="event-duration">{event.durationSeconds}s away</span>
                        )}
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {/* Security Events */}
              {selectedSubmission?.auditTrail?.securityEvents?.length > 0 && (
                <section className="detail-section warning-section">
                  <h3>⚠️ Security Events ({selectedSubmission.auditTrail.securityEvents.length})</h3>
                  <div className="event-list">
                    {selectedSubmission.auditTrail.securityEvents.map((event, idx) => (
                      <div key={idx} className="event-item security-event">
                        <span className="event-type">{event.event}</span>
                        <span className="event-time">{formatDate(event.timestamp)}</span>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {/* Submission Flags */}
              {selectedSubmission?.submissionFlags?.length > 0 && (
                <section className="detail-section flag-section">
                  <h3>🚩 Flagged Issues ({selectedSubmission.submissionFlags.length})</h3>
                  <div className="flag-list">
                    {selectedSubmission.submissionFlags.map((flag, idx) => (
                      <div key={idx} className={`flag-item severity-${flag.severity}`}>
                        <span className="flag-name">{getFlagDescription(flag.flag)}</span>
                        <span className="severity-badge">{flag.severity.toUpperCase()}</span>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {/* Validation Summary */}
              {selectedSubmission?.submissionValidation && (
                <section className="detail-section">
                  <h3>✓ Validation Summary</h3>
                  <p>
                    <strong>Total Time Valid:</strong>{' '}
                    {selectedSubmission.submissionValidation.totalTimeValid ? '✓ Yes' : '✗ No'}
                  </p>
                  <p>
                    <strong>Avg Time Per Question:</strong>{' '}
                    {selectedSubmission.submissionValidation.averageTimePerQuestion?.toFixed(2)}s
                  </p>
                  <p>
                    <strong>Duplicate Answers:</strong> {selectedSubmission.submissionValidation.duplicateAnswerCount}
                  </p>
                  {selectedSubmission.submissionValidation.flagReason && (
                    <p>
                      <strong>Flag Reason:</strong> {selectedSubmission.submissionValidation.flagReason}
                    </p>
                  )}
                </section>
              )}
            </div>

            <div className="modal-footer">
              <button className="btn-close-modal" onClick={() => setSelectedSubmission(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default QuizAuditLog;
