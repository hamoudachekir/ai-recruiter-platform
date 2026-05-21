import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import axios from "axios";
import { toast } from "react-toastify";
import PublicLayout from "../../layouts/PublicLayout";
import "./JobInterviewRooms.css";

const API_BASE =
  import.meta.env.VITE_API_BASE_URL || "http://localhost:3001";

const STYLES = ["friendly", "strict", "senior", "junior", "fast_screening"];

// Replace hallucinated ObjectIds in LLM text with real candidate names
const resolveIds = (text, rankings = []) => {
  if (!text || !rankings.length) return text;
  const map = {};
  rankings.forEach((r) => {
    const id = String(r.session_id || r.sessionId || "");
    const name = r.candidateName || r.name || id;
    if (id && name && name !== id) map[id] = name;
  });
  if (!Object.keys(map).length) return text;
  let out = text;
  // 1. exact replacement
  Object.entries(map).forEach(([id, name]) => { out = out.split(id).join(name); });
  // 2. regex fallback for hallucinated IDs (wrong length / extra zeros)
  out = out.replace(/\b[0-9a-f]{16,}\b/gi, (match) => {
    const m = match.toLowerCase();
    for (const [id, name] of Object.entries(map)) {
      const i = id.toLowerCase();
      const iSuffix = i.replace(/0+/, "").slice(-4);
      const mSuffix = m.replace(/0+/, "").slice(-4);
      if (iSuffix && mSuffix && iSuffix === mSuffix) return name;
      if (i.slice(0, 4) === m.slice(0, 4) && i.slice(-2) === m.slice(-2)) return name;
    }
    return match;
  });
  return out;
};

const fmt = (d) => {
  if (!d) return "—";
  try {
    return new Date(d).toLocaleString();
  } catch {
    return String(d);
  }
};

const sessionStatusLabel = {
  waiting_confirmation: "Waiting",
  active: "In progress",
  ended: "Completed",
  rejected: "Rejected",
};

const JobInterviewRooms = () => {
  const { entrepriseId } = useParams();
  const token = localStorage.getItem("token");
  const headers = useMemo(
    () => ({ Authorization: `Bearer ${token}` }),
    [token],
  );

  const [jobs, setJobs] = useState([]);
  const [rooms, setRooms] = useState([]);
  const [selectedJobId, setSelectedJobId] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState({
    jobId: "",
    title: "",
    description: "",
    interviewStyle: "friendly",
    maxCandidates: 0,
    requireFaceVerification: false,
  });

  const [activeRoomId, setActiveRoomId] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [comparison, setComparison] = useState(null);
  const [comparisonLoading, setComparisonLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [statsTick, setStatsTick] = useState(0);

  // ─── Data fetching ─────────────────────────────────────────────────────────

  const fetchJobs = useCallback(async () => {
    try {
      const res = await axios.get(
        `${API_BASE}/Frontend/jobs-by-entreprise/${entrepriseId}`,
      );
      setJobs(Array.isArray(res.data) ? res.data : []);
    } catch (err) {
      console.warn("Failed to load jobs:", err.message);
    }
  }, [entrepriseId]);

  const fetchRooms = useCallback(async () => {
    try {
      setLoading(true);
      const url = selectedJobId
        ? `${API_BASE}/api/job-rooms?jobId=${selectedJobId}`
        : `${API_BASE}/api/job-rooms`;
      const res = await axios.get(url, { headers });
      setRooms(res.data?.rooms || []);
    } catch (err) {
      toast.error(err.response?.data?.message || "Failed to load rooms");
    } finally {
      setLoading(false);
    }
  }, [headers, selectedJobId]);

  const fetchSessions = useCallback(
    async (roomId) => {
      try {
        const res = await axios.get(
          `${API_BASE}/api/job-rooms/${roomId}/sessions`,
          { headers },
        );
        setSessions(res.data?.sessions || []);
      } catch (err) {
        toast.error(err.response?.data?.message || "Failed to load sessions");
      }
    },
    [headers],
  );

  const fetchComparison = useCallback(
    async (roomId) => {
      try {
        const res = await axios.get(
          `${API_BASE}/api/job-rooms/${roomId}/comparison`,
          { headers },
        );
        setComparison(res.data?.comparison || null);
      } catch (err) {
        if (err.response?.status !== 404) {
          console.warn("Failed to load comparison:", err.message);
        }
        setComparison(null);
      }
    },
    [headers],
  );

  useEffect(() => {
    fetchJobs();
  }, [fetchJobs]);

  useEffect(() => {
    fetchRooms();
  }, [fetchRooms, statsTick]);

  useEffect(() => {
    if (!activeRoomId) return;
    fetchSessions(activeRoomId);
    fetchComparison(activeRoomId);
  }, [activeRoomId, fetchSessions, fetchComparison, statsTick]);

  // Live-ish counters: poll every 15s while a room is open.
  useEffect(() => {
    const t = setInterval(() => setStatsTick((n) => n + 1), 15000);
    return () => clearInterval(t);
  }, []);

  // ─── Actions ───────────────────────────────────────────────────────────────

  const handleCreate = async () => {
    if (!createForm.jobId) {
      toast.warn("Pick a job first");
      return;
    }
    try {
      const res = await axios.post(
        `${API_BASE}/api/job-rooms`,
        {
          jobId: createForm.jobId,
          title: createForm.title,
          description: createForm.description,
          settings: {
            interviewStyle: createForm.interviewStyle,
            maxCandidates: Number(createForm.maxCandidates) || 0,
            requireFaceVerification: createForm.requireFaceVerification,
          },
        },
        { headers },
      );
      toast.success("Interview room created");
      setCreateOpen(false);
      setCreateForm({
        jobId: "",
        title: "",
        description: "",
        interviewStyle: "friendly",
        maxCandidates: 0,
        requireFaceVerification: false,
      });
      setStatsTick((n) => n + 1);
      setActiveRoomId(res.data?.room?._id || null);
    } catch (err) {
      toast.error(err.response?.data?.message || "Could not create room");
    }
  };

  const handleClose = async (room) => {
    const url =
      room.status === "open"
        ? `${API_BASE}/api/job-rooms/${room._id}/close`
        : `${API_BASE}/api/job-rooms/${room._id}/reopen`;
    try {
      await axios.patch(url, {}, { headers });
      setStatsTick((n) => n + 1);
    } catch (err) {
      toast.error(err.response?.data?.message || "Action failed");
    }
  };

  const handleCopyLink = (slug) => {
    const url = `${window.location.origin}/join/${slug}`;
    navigator.clipboard
      ?.writeText(url)
      .then(() => toast.success("Invite link copied"))
      .catch(() => toast.info(url));
  };

  const handleRunComparison = async () => {
    if (!activeRoomId) return;
    setComparisonLoading(true);
    try {
      // NVIDIA Llama 3.3 70B free-tier routinely takes 2-3 minutes to rank
      // 5+ candidates. Match the server's 5-minute socket timeout so we
      // don't abort early and show a misleading "Comparison failed" toast
      // while the backend is still working.
      const res = await axios.post(
        `${API_BASE}/api/job-rooms/${activeRoomId}/comparison`,
        { includeOnlyCompleted: true },
        { headers, timeout: 300000 },
      );
      setComparison(res.data?.comparison || null);
      toast.success("Ranking generated");
    } catch (err) {
      // ECONNABORTED = the axios timeout fired. The server is still working;
      // the report will land in the next /comparison fetch.
      if (err?.code === "ECONNABORTED") {
        toast.info(
          "Ranking is taking longer than expected — it will appear shortly. " +
            "You can also click 'Refresh' in a minute to see the result.",
        );
      } else {
        toast.error(
          err.response?.data?.error ||
            err.response?.data?.message ||
            "Comparison failed",
        );
      }
    } finally {
      setComparisonLoading(false);
    }
  };

  const handleExportPdf = () => {
    if (!activeRoomId) return;
    const url = `${API_BASE}/api/job-rooms/${activeRoomId}/comparison/pdf?token=${encodeURIComponent(token)}`;
    const a = document.createElement("a");
    a.href = url;
    a.download = `comparison-${activeRoomId}.pdf`;
    a.rel = "noopener noreferrer";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  // ─── Rendering ─────────────────────────────────────────────────────────────

  const activeRoom = rooms.find((r) => r._id === activeRoomId) || null;

  const [filter, setFilter] = useState("");
  const [sortBy, setSortBy] = useState("rank");

  const sortedRankings = useMemo(() => {
    if (!comparison?.rankings) return [];
    const f = filter.trim().toLowerCase();
    const list = comparison.rankings.filter((r) =>
      !f
        ? true
        : (r.candidateName || "").toLowerCase().includes(f) ||
          (r.hiringRecommendation || "").toLowerCase().includes(f),
    );
    return [...list].sort((a, b) => {
      if (sortBy === "score")
        return (b.suitabilityScore || 0) - (a.suitabilityScore || 0);
      if (sortBy === "name")
        return (a.candidateName || "").localeCompare(b.candidateName || "");
      return (a.rank || 999) - (b.rank || 999);
    });
  }, [comparison, filter, sortBy]);

  return (
    <PublicLayout>
      <div className="jir-page">
        <div className="jir-header">
          <div>
            <h2>Job-linked interview rooms</h2>
            <p className="jir-sub">
              Spin up a shareable interview room per job posting. Candidates join
              via the invite link, their session is auto-linked to job and
              company, and the AI ranks them when you're ready.
            </p>
          </div>
          <div className="jir-header-actions">
            <Link to={`/entreprise/${entrepriseId}`} className="jir-btn ghost">
              ← Profile
            </Link>
            <button
              type="button"
              className="jir-btn primary"
              onClick={() => setCreateOpen(true)}
            >
              + New room
            </button>
          </div>
        </div>

        <div className="jir-filters">
          <label>
            Job
            <select
              value={selectedJobId}
              onChange={(e) => setSelectedJobId(e.target.value)}
            >
              <option value="">All jobs</option>
              {jobs.map((j) => (
                <option key={j._id} value={j._id}>
                  {j.title}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="jir-grid">
          {loading && <div className="jir-empty">Loading rooms…</div>}
          {!loading && rooms.length === 0 && (
            <div className="jir-empty">
              No interview rooms yet. Create one for any of your open jobs.
            </div>
          )}
          {rooms.map((room) => {
            const isActive = room._id === activeRoomId;
            return (
              <div
                key={room._id}
                role="button"
                tabIndex={0}
                className={`jir-card ${isActive ? "active" : ""}`}
                onClick={() => setActiveRoomId(room._id)}
                onKeyDown={(e) => e.key === "Enter" && setActiveRoomId(room._id)}
              >
                <div className="jir-card-top">
                  <span className={`jir-badge ${room.status}`}>
                    {room.status}
                  </span>
                  <span className="jir-style">
                    {room.settings?.interviewStyle}
                  </span>
                </div>
                <div className="jir-card-title">
                  {room.title || "Untitled room"}
                </div>
                <div className="jir-card-job">
                  {room.job?.title || "No job linked"}
                </div>
                <div className="jir-stats">
                  <div>
                    <span className="jir-num">
                      {room.stats?.totalSessions ?? 0}
                    </span>
                    <span>total</span>
                  </div>
                  <div>
                    <span className="jir-num green">
                      {room.stats?.completedSessions ?? 0}
                    </span>
                    <span>done</span>
                  </div>
                  <div>
                    <span className="jir-num amber">
                      {room.stats?.inProgressSessions ?? 0}
                    </span>
                    <span>live</span>
                  </div>
                </div>
                <div className="jir-card-actions" onClick={(e) => e.stopPropagation()}>
                  <button
                    type="button"
                    className="jir-btn tiny"
                    onClick={() => handleCopyLink(room.slug)}
                  >
                    Copy invite link
                  </button>
                  <button
                    type="button"
                    className="jir-btn tiny ghost"
                    onClick={() => handleClose(room)}
                  >
                    {room.status === "open" ? "Close" : "Reopen"}
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        {activeRoom && (
          <section className="jir-detail">
            <div className="jir-detail-head">
              <div>
                <h3>{activeRoom.title}</h3>
                <code className="jir-slug">
                  {window.location.origin}/join/{activeRoom.slug}
                </code>
              </div>
              <div className="jir-detail-actions">
                <button
                  type="button"
                  className="jir-btn ghost"
                  onClick={() => handleCopyLink(activeRoom.slug)}
                >
                  Copy link
                </button>
                <Link
                  to={`/entreprise/${entrepriseId}/interview-rooms/${activeRoom._id}/compare`}
                  className="jir-btn"
                >
                  Compare candidates
                </Link>
                <button
                  type="button"
                  className="jir-btn primary"
                  disabled={
                    comparisonLoading ||
                    sessions.filter((s) => s.status === "ended").length < 2
                  }
                  onClick={handleRunComparison}
                >
                  {comparisonLoading ? "Ranking…" : "Run AI comparison"}
                </button>
                {comparison?.status === "ready" && (
                  <button
                    type="button"
                    className="jir-btn"
                    onClick={handleExportPdf}
                  >
                    Export PDF
                  </button>
                )}
              </div>
            </div>

            <div className="jir-detail-grid">
              <div className="jir-panel">
                <h4>Candidate sessions ({sessions.length})</h4>
                <div className="jir-sessions">
                  {sessions.length === 0 && (
                    <div className="jir-empty small">
                      No sessions yet. Share the invite link with applicants.
                    </div>
                  )}
                  {sessions.map((s) => (
                    <div key={s._id} className="jir-session">
                      <div className="jir-session-main">
                        <strong>
                          {s.candidate?.firstName} {s.candidate?.lastName}
                        </strong>
                        <span className="jir-session-email">
                          {s.candidate?.email}
                        </span>
                      </div>
                      <div className="jir-session-meta">
                        <span
                          className={`jir-badge ${
                            s.status === "ended" ? "open" : s.status
                          }`}
                        >
                          {sessionStatusLabel[s.status] || s.status}
                        </span>
                        <span>{fmt(s.recordingEndedAt || s.createdAt)}</span>
                        {s.overallScore != null && (
                          <span className="jir-score">
                            {Number(s.overallScore).toFixed(1)}
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="jir-panel">
                <div className="jir-leader-head">
                  <h4>AI ranking</h4>
                  {comparison && (
                    <span className={`jir-badge ${comparison.status}`}>
                      {comparison.status}
                    </span>
                  )}
                </div>

                {!comparison && (
                  <div className="jir-empty small">
                    Run the AI comparison once at least 2 candidates have
                    completed their interview.
                  </div>
                )}

                {comparison?.status === "failed" && (
                  <div className="jir-error">
                    Last run failed: {comparison.error || "unknown error"}
                  </div>
                )}

                {comparison?.executiveSummary && (
                  <div className="jir-summary">
                    <strong>Executive summary</strong>
                    <p>{resolveIds(comparison.executiveSummary, comparison.rankings)}</p>
                  </div>
                )}

                {comparison?.rankings?.length > 0 && (
                  <>
                    <div className="jir-leader-controls">
                      <input
                        placeholder="Filter by name or recommendation"
                        value={filter}
                        onChange={(e) => setFilter(e.target.value)}
                      />
                      <select
                        value={sortBy}
                        onChange={(e) => setSortBy(e.target.value)}
                      >
                        <option value="rank">Sort: rank</option>
                        <option value="score">Sort: score</option>
                        <option value="name">Sort: name</option>
                      </select>
                    </div>

                    <ol className="jir-leaderboard">
                      {sortedRankings.map((row) => (
                        <li
                          key={`${row.rank}-${row.candidateName}`}
                          className="jir-rank-row"
                        >
                          <div className="jir-rank-num">#{row.rank}</div>
                          <div className="jir-rank-body">
                            <div className="jir-rank-head">
                              <strong>{row.candidateName || "Unknown"}</strong>
                              <span className="jir-rank-score">
                                {Number(row.suitabilityScore || 0).toFixed(1)} /
                                100
                              </span>
                            </div>
                            <div className="jir-rank-reco">
                              {row.hiringRecommendation}
                            </div>
                            <div className="jir-rank-just">
                              {row.justification}
                            </div>
                            <div className="jir-rank-metrics">
                              {row.metrics?.technicalTheta != null && (
                                <span>θ {row.metrics.technicalTheta}</span>
                              )}
                              {row.metrics?.technicalScore != null && (
                                <span>
                                  Tech {row.metrics.technicalScore}
                                </span>
                              )}
                              {row.metrics?.hrScore != null && (
                                <span>HR {row.metrics.hrScore}</span>
                              )}
                              {row.metrics?.integrityScore != null && (
                                <span>
                                  Integrity {row.metrics.integrityScore}
                                </span>
                              )}
                            </div>
                          </div>
                        </li>
                      ))}
                    </ol>
                  </>
                )}
              </div>
            </div>
          </section>
        )}

        {createOpen && (
          <div className="jir-modal" role="dialog" aria-modal="true">
            <div className="jir-modal-body">
              <h3>New interview room</h3>
              <label>
                Job
                <select
                  value={createForm.jobId}
                  onChange={(e) =>
                    setCreateForm((f) => ({ ...f, jobId: e.target.value }))
                  }
                >
                  <option value="">Select a job</option>
                  {jobs.map((j) => (
                    <option key={j._id} value={j._id}>
                      {j.title}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Title (optional)
                <input
                  value={createForm.title}
                  onChange={(e) =>
                    setCreateForm((f) => ({ ...f, title: e.target.value }))
                  }
                />
              </label>
              <label>
                Description
                <textarea
                  rows={3}
                  value={createForm.description}
                  onChange={(e) =>
                    setCreateForm((f) => ({
                      ...f,
                      description: e.target.value,
                    }))
                  }
                />
              </label>
              <div className="jir-modal-row">
                <label>
                  Interview style
                  <select
                    value={createForm.interviewStyle}
                    onChange={(e) =>
                      setCreateForm((f) => ({
                        ...f,
                        interviewStyle: e.target.value,
                      }))
                    }
                  >
                    {STYLES.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Max candidates (0 = unlimited)
                  <input
                    type="number"
                    min="0"
                    value={createForm.maxCandidates}
                    onChange={(e) =>
                      setCreateForm((f) => ({
                        ...f,
                        maxCandidates: e.target.value,
                      }))
                    }
                  />
                </label>
              </div>
              <label className="jir-check">
                <input
                  type="checkbox"
                  checked={createForm.requireFaceVerification}
                  onChange={(e) =>
                    setCreateForm((f) => ({
                      ...f,
                      requireFaceVerification: e.target.checked,
                    }))
                  }
                />
                Require face verification before interview
              </label>
              <div className="jir-modal-actions">
                <button
                  type="button"
                  className="jir-btn ghost"
                  onClick={() => setCreateOpen(false)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="jir-btn primary"
                  onClick={handleCreate}
                >
                  Create room
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </PublicLayout>
  );
};

export default JobInterviewRooms;
