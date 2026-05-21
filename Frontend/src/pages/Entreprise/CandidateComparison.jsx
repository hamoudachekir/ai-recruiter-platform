import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import axios from "axios";
import { toast } from "react-toastify";

const IS_MOCK_MODE = import.meta.env.VITE_USE_MOCK_COMPARISON === "true";
import {
  RadarChart,
  PolarGrid,
  PolarAngleAxis,
  PolarRadiusAxis,
  Radar,
  Legend,
  ResponsiveContainer,
  Tooltip,
} from "recharts";
import PublicLayout from "../../layouts/PublicLayout";
import "./CandidateComparison.css";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:3001";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const fmtScore = (n, digits = 1) => {
  if (n == null || Number.isNaN(Number(n))) return "—";
  return Number(n).toFixed(digits);
};

const fmtDate = (d) => {
  if (!d) return "—";
  try { return new Date(d).toLocaleString(); } catch { return String(d); }
};

const fmtDuration = (s) => {
  if (s == null) return "—";
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}m ${sec}s`;
};

const clamp = (v, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, Number(v) || 0));

// Replace any raw session/candidate ObjectIds in LLM-generated text with real names.
// The LLM sometimes hallucinates slightly wrong IDs (wrong length), so we use:
//   1. Exact string replacement for known IDs
//   2. Regex fallback matching any hex blob that shares a suffix with a known ID
const resolveIds = (text, rankings = [], candidates = []) => {
  if (!text) return text;

  // Build id → name map
  const map = {};
  candidates.forEach((c) => {
    if (c.sessionId) {
      map[String(c.sessionId)] = c.candidateName || c.name || String(c.sessionId);
    }
  });
  rankings.forEach((r) => {
    const id = String(r.session_id || r.sessionId || "");
    if (!id) return;
    const name = r.candidateName || r.name ||
      candidates.find((c) => String(c.sessionId) === id)?.candidateName || id;
    if (name && name !== id) map[id] = name;
  });

  if (Object.keys(map).length === 0) return text;

  // 1. Exact replacement
  let out = text;
  Object.entries(map).forEach(([id, name]) => {
    out = out.split(id).join(name);
  });

  // 2. Regex fallback: replace any 16+ char hex sequence the LLM may have
  // hallucinated (wrong length / extra zeros).  Match by comparing the last
  // 4 significant hex chars against known IDs.
  out = out.replace(/\b[0-9a-f]{16,}\b/gi, (match) => {
    const mLower = match.toLowerCase();
    for (const [id, name] of Object.entries(map)) {
      const idLower = id.toLowerCase();
      // Suffix overlap: last 4 non-zero chars
      const idSuffix = idLower.replace(/0+/, "").slice(-4);
      const mSuffix  = mLower.replace(/0+/, "").slice(-4);
      if (idSuffix && mSuffix && idSuffix === mSuffix) return name;
      // Or: share first 4 + last 4 chars regardless of middle zeros
      if (idLower.slice(0, 4) === mLower.slice(0, 4) &&
          idLower.slice(-2)    === mLower.slice(-2)) return name;
    }
    return match;
  });

  return out;
};

const CANDIDATE_COLORS = ["#4a90e2", "#e74c3c", "#27ae60", "#f39c12", "#9b59b6"];

// Build a clean display name from whatever the backend gave us. Older
// ComparisonReport rows stored the candidate's email as the name, so we
// pretty-print the email local-part when we detect one. Returns full
// formatted name; pass { firstOnly: true } for compact contexts (radar
// legend, table headers, etc.).
const getDisplayName = (c, { firstOnly = false } = {}) => {
  if (!c) return "";
  const raw = String(c.candidateName || c.candidate?.email || "").trim();
  if (!raw) return "Unknown";
  // If raw looks like an email, prettify the local part.
  const cleaned = raw.includes("@")
    ? raw
        .split("@")[0]
        .replace(/\.test$/i, "")
        .replace(/[._-]+/g, " ")
        .replace(/\b\w/g, (m) => m.toUpperCase())
    : raw;
  return firstOnly ? cleaned.split(" ")[0] : cleaned;
};
const HIRE_REC_CLASS = {
  "Strongly Recommend": "rec-strong",
  Recommend: "rec-yes",
  Consider: "rec-maybe",
  "Do Not Recommend": "rec-no",
};

const LOADING_STEPS = [
  "Gathering interview data…",
  "Preparing candidate profiles…",
  "Running AI analysis…",
  "Calculating composite scores…",
  "Generating narrative comparison…",
  "Finalizing report…",
];

const RADAR_DIMS = [
  { key: "technical", label: "Technical" },
  { key: "theta_normalized", label: "IRT θ" },
  { key: "resilience", label: "Resilience" },
  { key: "system_design", label: "System Design" },
  { key: "problem_solving", label: "Problem Solving" },
  { key: "communication", label: "Communication" },
  { key: "hr_fit", label: "HR Fit" },
];

// ─── Component ────────────────────────────────────────────────────────────────

const CandidateComparison = () => {
  const { entrepriseId, roomId } = useParams();
  const navigate = useNavigate();
  const token = localStorage.getItem("token");
  const headers = useMemo(() => ({ Authorization: `Bearer ${token}` }), [token]);

  // view state machine
  const [view, setView] = useState("select"); // "select" | "loading" | "results"

  // data
  const [candidates, setCandidates] = useState([]);
  const [room, setRoom] = useState(null);
  const [comparison, setComparison] = useState(null); // full ComparisonReport
  const [initialLoading, setInitialLoading] = useState(true);

  // select-view controls
  const [selectedSessionIds, setSelectedSessionIds] = useState([]);
  const [sortBy, setSortBy] = useState("ai");
  const [filter, setFilter] = useState("");
  const [runError, setRunError] = useState(null);

  // winner-pick controls
  const [reasonText, setReasonText] = useState("");
  const [reasonForSessionId, setReasonForSessionId] = useState(null);

  // loading animation
  const [loadingStep, setLoadingStep] = useState(0);
  const loadingTimerRef = useRef(null);

  // ─── Data fetch ────────────────────────────────────────────────────────────

  const fetchData = useCallback(async () => {
    if (!roomId) return;
    try {
      const res = await axios.get(
        `${API_BASE}/api/job-rooms/${roomId}/candidates`,
        { headers }
      );
      const d = res.data || {};
      setCandidates(d.candidates || []);
      setRoom(d.room || null);

      // If a ready comparison exists, fetch full details and go straight to results
      if (d.comparison?.status === "ready") {
        try {
          const cr = await axios.get(
            `${API_BASE}/api/job-rooms/${roomId}/comparison`,
            { headers }
          );
          const full = cr.data?.comparison || d.comparison;
          // Merge aiRank data from candidates into the comparison rankings if needed
          setComparison(full);
          setView("results");
        } catch {
          setComparison(d.comparison);
          setView("results");
        }
      }
    } catch (err) {
      toast.error(err.response?.data?.message || "Failed to load candidates");
    } finally {
      setInitialLoading(false);
    }
  }, [roomId, headers]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // Loading step animation
  useEffect(() => {
    if (view !== "loading") {
      clearInterval(loadingTimerRef.current);
      setLoadingStep(0);
      return;
    }
    setLoadingStep(0);
    let step = 0;
    loadingTimerRef.current = setInterval(() => {
      step += 1;
      if (step >= LOADING_STEPS.length - 1) {
        clearInterval(loadingTimerRef.current);
        setLoadingStep(LOADING_STEPS.length - 1);
      } else {
        setLoadingStep(step);
      }
    }, 5000);
    return () => clearInterval(loadingTimerRef.current);
  }, [view]);

  // ─── Actions ───────────────────────────────────────────────────────────────

  const handleRunRanking = async () => {
    setRunError(null);
    setView("loading");
    try {
      const res = IS_MOCK_MODE
        ? await axios.get(`${API_BASE}/api/job-rooms/${roomId}/mock-analyze`, { headers })
        : await axios.post(
            `${API_BASE}/api/job-rooms/${roomId}/comparison`,
            { includeOnlyCompleted: true },
            { headers, timeout: 300000 }
          );
      const full = res.data?.comparison || null;
      if (full) {
        setComparison(full);
        // Refresh candidates list so aiRank is populated
        const cr = await axios.get(
          `${API_BASE}/api/job-rooms/${roomId}/candidates`,
          { headers }
        ).catch(() => null);
        if (cr?.data?.candidates) setCandidates(cr.data.candidates);
      }
      setView("results");
    } catch (err) {
      const serverMsg = err.response?.data?.error || err.response?.data?.message || "";
      const isQuota = serverMsg.toLowerCase().includes("quota") || err.response?.status === 429 || err.response?.status === 502;
      const msg = isQuota
        ? "Gemini API quota exceeded. All free-tier models were tried. Please wait a few minutes and retry."
        : serverMsg || "AI analysis failed. Ensure GEMINI_API_KEY is set in Backend/server/.env.";
      setRunError(msg);
      toast.error(msg, { autoClose: 8000 });
      setView("select");
    }
  };

  const handleSelectWinner = async (candidate) => {
    const reason = reasonForSessionId === candidate.sessionId ? reasonText.trim() : "";
    try {
      await axios.post(
        `${API_BASE}/api/job-rooms/${roomId}/select-winner`,
        { sessionId: candidate.sessionId, reason },
        { headers }
      );
      toast.success(`${candidate.candidateName} marked as chosen candidate`);
      setReasonForSessionId(null);
      setReasonText("");
      fetchData();
    } catch (err) {
      toast.error(err.response?.data?.message || "Could not save selection");
    }
  };

  const handleClearWinner = async () => {
    try {
      await axios.delete(`${API_BASE}/api/job-rooms/${roomId}/select-winner`, { headers });
      toast.info("Selection cleared");
      fetchData();
    } catch (err) {
      toast.error(err.response?.data?.message || "Could not clear selection");
    }
  };

  const handleExportPdf = () => {
    const url = `${API_BASE}/api/job-rooms/${roomId}/comparison/pdf?token=${encodeURIComponent(token)}`;
    const a = document.createElement("a");
    a.href = url;
    a.download = `comparison-${roomId}.pdf`;
    a.rel = "noopener noreferrer";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  // ─── Derived data ──────────────────────────────────────────────────────────

  const winnerSessionId = room?.selectedCandidate?.session
    ? String(room.selectedCandidate.session)
    : null;

  const sortedCandidates = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const list = candidates.filter((c) =>
      !f
        ? true
        : c.candidateName.toLowerCase().includes(f) ||
          (c.candidate?.email || "").toLowerCase().includes(f)
    );
    return [...list].sort((a, b) => {
      if (sortBy === "name") return a.candidateName.localeCompare(b.candidateName);
      if (sortBy === "theta")
        return (b.metrics?.technicalTheta ?? -999) - (a.metrics?.technicalTheta ?? -999);
      if (sortBy === "hr")
        return (b.metrics?.hrScore ?? -1) - (a.metrics?.hrScore ?? -1);
      if (sortBy === "composite")
        return (b.aiRank?.compositeScore ?? -1) - (a.aiRank?.compositeScore ?? -1);
      const ar = a.aiRank?.rank ?? 9999;
      const br = b.aiRank?.rank ?? 9999;
      if (ar !== br) return ar - br;
      return (b.aiRank?.suitabilityScore ?? -1) - (a.aiRank?.suitabilityScore ?? -1);
    });
  }, [candidates, sortBy, filter]);

  const compareList = useMemo(() => {
    if (selectedSessionIds.length === 0) return sortedCandidates;
    return sortedCandidates.filter((c) => selectedSessionIds.includes(c.sessionId));
  }, [sortedCandidates, selectedSessionIds]);

  // Max candidates the side-by-side comparison view can render legibly.
  // The radar chart + columnar layout get cramped past ~8; the limit exists
  // for readability, not as a backend constraint.
  const MAX_COMPARE = 8;

  const toggleSelect = (sessionId) => {
    setSelectedSessionIds((prev) => {
      if (prev.includes(sessionId)) return prev.filter((id) => id !== sessionId);
      if (prev.length >= MAX_COMPARE) {
        toast.info(`Compare up to ${MAX_COMPARE} candidates at a time`);
        return prev;
      }
      return [...prev, sessionId];
    });
  };

  // Summary metric cards
  const metricCards = useMemo(() => {
    const ranked = candidates.filter((c) => c.aiRank);
    const withMetrics = candidates.filter((c) => c.metrics);
    const avg = (arr, fn) => {
      const vals = arr.map(fn).filter((v) => v != null && !Number.isNaN(Number(v)));
      return vals.length ? vals.reduce((a, b) => a + Number(b), 0) / vals.length : null;
    };
    return {
      avgTheta: avg(withMetrics, (c) => c.metrics?.technicalTheta),
      topTech: Math.max(...withMetrics.map((c) => Number(c.metrics?.technicalScore) || 0), 0) || null,
      avgHr: avg(withMetrics, (c) => c.metrics?.hrScore),
      avgResilience: avg(withMetrics, (c) => c.metrics?.resilienceIndex),
      topComposite: Math.max(...ranked.map((c) => Number(c.aiRank?.compositeScore) || 0), 0) || null,
    };
  }, [candidates]);

  // Radar chart data
  const radarData = useMemo(() => {
    const list = compareList.slice(0, 4);
    return RADAR_DIMS.map(({ key, label }) => {
      const point = { dimension: label };
      list.forEach((c, i) => {
        const bd = c.aiRank?.compositeBreakdown || {};
        point[`c${i}`] = clamp(bd[key] ?? 0);
      });
      return point;
    });
  }, [compareList]);

  // ─── Render ────────────────────────────────────────────────────────────────

  if (initialLoading) {
    return (
      <PublicLayout>
        <div className="cc-page cc-centered">
          <div className="cc-spinner" />
          <p>Loading…</p>
        </div>
      </PublicLayout>
    );
  }

  if (!room) {
    return (
      <PublicLayout>
        <div className="cc-page">
          <div className="cc-empty">Interview room not found.</div>
        </div>
      </PublicLayout>
    );
  }

  return (
    <PublicLayout>
      <div className="cc-page">
        {/* ── Breadcrumb ─────────────────────────────────────────────────── */}
        <div className="cc-breadcrumb">
          <Link to={`/entreprise/${entrepriseId}/interview-rooms`}>← Interview Rooms</Link>
          <span> / {room.title || "Candidate Comparison"}</span>
        </div>

        {/* ── Mock mode banner ───────────────────────────────────────────── */}
        {IS_MOCK_MODE && (
          <div className="cc-alert mock-banner">
            <strong>Test mode active</strong> — using seeded candidates for job:{" "}
            <em>{room.job?.title || "Senior Backend Engineer"}</em>. Clicking
            "Run AI Ranking" returns a pre-built mock result instantly (no Gemini
            call). Set <code>VITE_USE_MOCK_COMPARISON=false</code> to switch to
            live mode.
          </div>
        )}

        {/* ── View: SELECT ──────────────────────────────────────────────── */}
        {view === "select" && (
          <SelectView
            room={room}
            candidates={candidates}
            sortedCandidates={sortedCandidates}
            selectedSessionIds={selectedSessionIds}
            winnerSessionId={winnerSessionId}
            sortBy={sortBy}
            filter={filter}
            runError={runError}
            onSortChange={setSortBy}
            onFilterChange={setFilter}
            onToggleSelect={toggleSelect}
            onClearSelection={() => setSelectedSessionIds([])}
            onRunRanking={handleRunRanking}
          />
        )}

        {/* ── View: LOADING ─────────────────────────────────────────────── */}
        {view === "loading" && <LoadingView step={loadingStep} />}

        {/* ── View: RESULTS ─────────────────────────────────────────────── */}
        {view === "results" && (
          <ResultsView
            room={room}
            candidates={candidates}
            comparison={comparison}
            compareList={compareList}
            sortedCandidates={sortedCandidates}
            winnerSessionId={winnerSessionId}
            selectedSessionIds={selectedSessionIds}
            sortBy={sortBy}
            filter={filter}
            metricCards={metricCards}
            radarData={radarData}
            reasonText={reasonText}
            reasonForSessionId={reasonForSessionId}
            onSortChange={setSortBy}
            onFilterChange={setFilter}
            onToggleSelect={toggleSelect}
            onClearSelection={() => setSelectedSessionIds([])}
            onRunRanking={handleRunRanking}
            onSelectWinner={handleSelectWinner}
            onClearWinner={handleClearWinner}
            onExportPdf={handleExportPdf}
            onBackToSelect={() => setView("select")}
            onReasonChange={setReasonText}
            onSetReasonFor={setReasonForSessionId}
            navigate={navigate}
          />
        )}
      </div>
    </PublicLayout>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// SelectView
// ─────────────────────────────────────────────────────────────────────────────
const SelectView = ({
  room, candidates, sortedCandidates, selectedSessionIds, winnerSessionId,
  sortBy, filter, runError,
  onSortChange, onFilterChange, onToggleSelect, onClearSelection, onRunRanking,
}) => (
  <div>
    <div className="cc-header">
      <div>
        <h2>{room.title || "Candidate Comparison"}</h2>
        <p className="cc-sub">
          Review completed candidates for <strong>{room.job?.title || "this position"}</strong>.
          Select up to 4 to compare, then run the AI ranking.
        </p>
      </div>
      <div className="cc-header-actions">
        <button
          type="button"
          className="cc-btn primary"
          disabled={candidates.length < 2}
          onClick={onRunRanking}
        >
          ✨ Run AI Ranking
        </button>
      </div>
    </div>

    {runError && <div className="cc-alert error">{runError}</div>}
    {candidates.length === 0 && (
      <div className="cc-empty">
        No completed interview sessions found for this room yet.
      </div>
    )}

    {candidates.length > 0 && (
      <>
        <div className="cc-toolbar">
          <input
            placeholder="Filter by name or email"
            value={filter}
            onChange={(e) => onFilterChange(e.target.value)}
          />
          <select value={sortBy} onChange={(e) => onSortChange(e.target.value)}>
            <option value="ai">AI rank</option>
            <option value="composite">Composite score</option>
            <option value="theta">Technical θ</option>
            <option value="hr">HR score</option>
            <option value="name">Name</option>
          </select>
          {selectedSessionIds.length > 0 && (
            <>
              <span className="cc-selected-count">
                {selectedSessionIds.length} selected
              </span>
              <button type="button" className="cc-btn ghost tiny" onClick={onClearSelection}>
                Reset
              </button>
            </>
          )}
        </div>

        <div className="cc-roster">
          {sortedCandidates.map((c) => {
            const isWinner = c.sessionId === winnerSessionId;
            const isSelected = selectedSessionIds.includes(c.sessionId);
            return (
              <button
                type="button"
                key={c.sessionId}
                className={`cc-roster-row${isSelected ? " selected" : ""}${isWinner ? " winner" : ""}`}
                onClick={() => onToggleSelect(c.sessionId)}
              >
                <div className="cc-roster-rank">
                  {c.aiRank?.rank ? `#${c.aiRank.rank}` : "—"}
                </div>
                <div className="cc-roster-name">
                  <strong>{getDisplayName(c)}</strong>
                  <span>{c.candidate?.email}</span>
                </div>
                <div className="cc-roster-metric">
                  <span>AI</span>
                  <strong>{fmtScore(c.aiRank?.suitabilityScore, 0)}</strong>
                </div>
                <div className="cc-roster-metric">
                  <span>θ</span>
                  <strong>{fmtScore(c.metrics?.technicalTheta)}</strong>
                </div>
                <div className="cc-roster-metric">
                  <span>Tech</span>
                  <strong>{fmtScore(c.metrics?.technicalScore, 0)}</strong>
                </div>
                <div className="cc-roster-metric">
                  <span>HR</span>
                  <strong>{fmtScore(c.metrics?.hrScore, 0)}</strong>
                </div>
                {isWinner && <span className="cc-winner-chip">Pick</span>}
              </button>
            );
          })}
        </div>
      </>
    )}
  </div>
);

// ─────────────────────────────────────────────────────────────────────────────
// LoadingView
// ─────────────────────────────────────────────────────────────────────────────
const LoadingView = ({ step }) => (
  <div className="cc-loading-view">
    <div className="cc-loading-ring" />
    <h3>Analyzing candidates…</h3>
    <ul className="cc-loading-steps">
      {LOADING_STEPS.map((s, i) => (
        <li
          key={s}
          className={
            i < step ? "done" : i === step ? "active" : "pending"
          }
        >
          <span className="cc-step-icon">
            {i < step ? "✓" : i === step ? "◉" : "○"}
          </span>
          {s}
        </li>
      ))}
    </ul>
    <p className="cc-loading-note">
      Claude AI is reviewing each candidate — this takes up to 45 seconds.
    </p>
  </div>
);

// ─────────────────────────────────────────────────────────────────────────────
// ResultsView
// ─────────────────────────────────────────────────────────────────────────────
const ResultsView = ({
  room, candidates, comparison, compareList, sortedCandidates,
  winnerSessionId, selectedSessionIds, sortBy, filter,
  metricCards, radarData,
  reasonText, reasonForSessionId,
  onSortChange, onFilterChange, onToggleSelect, onClearSelection,
  onRunRanking, onSelectWinner, onClearWinner, onExportPdf, onBackToSelect,
  onReasonChange, onSetReasonFor, navigate,
}) => {
  const recommendedCandidate = candidates.find(
    (c) => c.sessionId === comparison?.recommendedCandidateId
  );

  const winnerCandidateName = candidates.find(
    (c) => c.sessionId === winnerSessionId
  )?.candidateName;

  return (
    <div>
      {/* ── Results header ──────────────────────────────────────────────── */}
      <div className="cc-results-header">
        <div>
          <h2>{room.title || "Comparison Results"}</h2>
          <p className="cc-sub">
            <strong>{room.job?.title || "Position"}</strong> ·{" "}
            {candidates.length} candidate{candidates.length !== 1 ? "s" : ""} ·{" "}
            {comparison?.generatedAt
              ? `Analyzed ${fmtDate(comparison.generatedAt)}`
              : "Analysis complete"}
            {comparison?.llmProvider && (
              <span className={`cc-provider-chip${comparison.llmProvider === "mock/hardcoded" ? " mock" : ""}`}>
                {comparison.llmProvider === "mock/hardcoded" ? "Test mode — mock AI result" : comparison.llmProvider}
              </span>
            )}
          </p>
        </div>
        <div className="cc-header-actions">
          <button type="button" className="cc-btn ghost" onClick={onBackToSelect}>
            ← Back
          </button>
          <button
            type="button"
            className="cc-btn"
            onClick={onExportPdf}
            disabled={comparison?.status !== "ready"}
          >
            Export PDF
          </button>
          <button
            type="button"
            className="cc-btn primary"
            onClick={onRunRanking}
          >
            Re-run AI
          </button>
        </div>
      </div>

      {/* ── 4 Metric summary cards ──────────────────────────────────────── */}
      <div className="cc-metric-cards">
        <MetricCard
          label="Avg. Technical θ"
          value={metricCards.avgTheta != null ? Number(metricCards.avgTheta).toFixed(2) : "—"}
          sub="IRT ability estimate"
          color="#4a90e2"
        />
        <MetricCard
          label="Top Technical Score"
          value={metricCards.topTech != null ? `${Math.round(metricCards.topTech)}` : "—"}
          sub="out of 100"
          color="#27ae60"
        />
        <MetricCard
          label="Avg. HR Score"
          value={metricCards.avgHr != null ? `${Math.round(metricCards.avgHr)}` : "—"}
          sub="out of 100"
          color="#9b59b6"
        />
        <MetricCard
          label="Avg. Resilience"
          value={metricCards.avgResilience != null ? `${Math.round(metricCards.avgResilience)}` : "—"}
          sub="out of 100"
          color="#e67e22"
        />
      </div>

      {/* ── Close-call banner ───────────────────────────────────────────── */}
      {comparison?.isClosingCall && (
        <div className="cc-alert close-call">
          <strong>⚠ Close Call</strong> — The top two candidates are very closely
          matched. Consider this follow-up question to differentiate:
          {comparison.tiebreakerQuestion && (
            <blockquote className="cc-tiebreaker">
              "{comparison.tiebreakerQuestion}"
            </blockquote>
          )}
        </div>
      )}

      {/* ── Current winner banner ───────────────────────────────────────── */}
      {winnerSessionId && (
        <div className="cc-winner-banner">
          <span>
            ✅ Current pick: <strong>{winnerCandidateName || "Unknown"}</strong>
            {room?.selectedCandidate?.reason && (
              <em> — {room.selectedCandidate.reason}</em>
            )}
          </span>
          <button type="button" className="cc-btn ghost tiny" onClick={onClearWinner}>
            Clear
          </button>
        </div>
      )}

      {/* ── AI Recommendation card ──────────────────────────────────────── */}
      {recommendedCandidate && (
        <div className="cc-ai-recommendation">
          <div className="cc-ai-rec-badge">AI Recommendation</div>
          <div className="cc-ai-rec-content">
            <div className="cc-ai-rec-winner">
              <div className="cc-ai-rec-rank">#1</div>
              <div>
                <h3>{getDisplayName(recommendedCandidate)}</h3>
                <p className="cc-ai-rec-email">{recommendedCandidate.candidate?.email}</p>
              </div>
              <div className="cc-ai-rec-right">
                <div className="cc-confidence">
                  <span className="cc-confidence-val">
                    {comparison.confidencePct != null
                      ? `${comparison.confidencePct}%`
                      : "—"}
                  </span>
                  <span className="cc-confidence-lbl">confidence</span>
                </div>
                {recommendedCandidate.aiRank?.hiringRecommendation && (
                  <span
                    className={`cc-hire-rec ${
                      HIRE_REC_CLASS[recommendedCandidate.aiRank.hiringRecommendation] || ""
                    }`}
                  >
                    {recommendedCandidate.aiRank.hiringRecommendation}
                  </span>
                )}
              </div>
            </div>
            {comparison.justification && (
              <p className="cc-ai-justification">{resolveIds(comparison.justification, comparison.rankings, candidates)}</p>
            )}
          </div>
        </div>
      )}

      {/* ── Executive summary ───────────────────────────────────────────── */}
      {comparison?.executiveSummary && (
        <div className="cc-summary">
          <strong>Executive Summary</strong>
          <p>{resolveIds(comparison.executiveSummary, comparison.rankings, candidates)}</p>
        </div>
      )}

      {/* ── Candidate roster ────────────────────────────────────────────── */}
      <h3 className="cc-section-title">Candidate Roster</h3>
      <div className="cc-toolbar">
        <input
          placeholder="Filter by name or email"
          value={filter}
          onChange={(e) => onFilterChange(e.target.value)}
        />
        <select value={sortBy} onChange={(e) => onSortChange(e.target.value)}>
          <option value="ai">AI rank</option>
          <option value="composite">Composite score</option>
          <option value="theta">Technical θ</option>
          <option value="hr">HR score</option>
          <option value="name">Name</option>
        </select>
        {selectedSessionIds.length > 0 && (
          <>
            <span className="cc-selected-count">{selectedSessionIds.length} selected</span>
            <button type="button" className="cc-btn ghost tiny" onClick={onClearSelection}>
              Reset
            </button>
          </>
        )}
      </div>
      <div className="cc-roster">
        {sortedCandidates.map((c) => {
          const isWinner = c.sessionId === winnerSessionId;
          const isSelected = selectedSessionIds.includes(c.sessionId);
          const isRec = c.sessionId === comparison?.recommendedCandidateId;
          return (
            <button
              type="button"
              key={c.sessionId}
              className={`cc-roster-row${isSelected ? " selected" : ""}${isWinner ? " winner" : ""}${isRec ? " recommended" : ""}`}
              onClick={() => onToggleSelect(c.sessionId)}
            >
              <div className="cc-roster-rank">
                {c.aiRank?.rank ? `#${c.aiRank.rank}` : "—"}
              </div>
              <div className="cc-roster-name">
                <strong>{getDisplayName(c)}</strong>
                <span>{c.candidate?.email}</span>
              </div>
              <div className="cc-roster-metric">
                <span>Composite</span>
                <strong>{fmtScore(c.aiRank?.compositeScore, 0)}</strong>
              </div>
              <div className="cc-roster-metric">
                <span>AI</span>
                <strong>{fmtScore(c.aiRank?.suitabilityScore, 0)}</strong>
              </div>
              <div className="cc-roster-metric">
                <span>θ</span>
                <strong>{fmtScore(c.metrics?.technicalTheta)}</strong>
              </div>
              <div className="cc-roster-metric">
                <span>HR</span>
                <strong>{fmtScore(c.metrics?.hrScore, 0)}</strong>
              </div>
              {isWinner && <span className="cc-winner-chip">Pick</span>}
              {isRec && !isWinner && <span className="cc-ai-chip">AI Pick</span>}
            </button>
          );
        })}
      </div>

      {/* ── Score breakdown cards ───────────────────────────────────────── */}
      {compareList.length > 0 && (
        <>
          <h3 className="cc-section-title">
            Score Breakdown {selectedSessionIds.length > 0 ? `(${compareList.length} selected)` : ""}
          </h3>
          <div
            className="cc-score-grid"
            style={{ gridTemplateColumns: `repeat(${Math.min(compareList.length, 4)}, minmax(260px, 1fr))` }}
          >
            {compareList.slice(0, 4).map((c, ci) => {
              const isWinner = c.sessionId === winnerSessionId;
              const isRec = c.sessionId === comparison?.recommendedCandidateId;
              const bd = c.aiRank?.compositeBreakdown || {};
              const color = CANDIDATE_COLORS[ci] || "#4a90e2";
              return (
                <ScoreCard
                  key={c.sessionId}
                  candidate={c}
                  breakdown={bd}
                  color={color}
                  isWinner={isWinner}
                  isRecommended={isRec}
                  reasonText={reasonText}
                  reasonForSessionId={reasonForSessionId}
                  onSelectWinner={onSelectWinner}
                  onReasonChange={onReasonChange}
                  onSetReasonFor={onSetReasonFor}
                  navigate={navigate}
                />
              );
            })}
          </div>
        </>
      )}

      {/* ── Radar chart + Dimension table ───────────────────────────────── */}
      {compareList.length > 0 && (
        <div className="cc-analysis-row">
          <div className="cc-radar-section">
            <h3 className="cc-section-title">Competency Radar</h3>
            <ResponsiveContainer width="100%" height={340}>
              <RadarChart data={radarData} margin={{ top: 10, right: 20, bottom: 10, left: 20 }}>
                <PolarGrid stroke="#e5e7eb" />
                <PolarAngleAxis dataKey="dimension" tick={{ fontSize: 12, fill: "#374151" }} />
                <PolarRadiusAxis angle={30} domain={[0, 100]} tick={false} axisLine={false} />
                {compareList.slice(0, 4).map((c, i) => (
                  <Radar
                    key={c.sessionId}
                    name={getDisplayName(c)}
                    dataKey={`c${i}`}
                    stroke={CANDIDATE_COLORS[i]}
                    fill={CANDIDATE_COLORS[i]}
                    fillOpacity={0.15}
                    strokeWidth={2}
                  />
                ))}
                <Tooltip />
                <Legend
                  verticalAlign="bottom"
                  align="center"
                  wrapperStyle={{
                    fontSize: 12,
                    paddingTop: 10,
                    lineHeight: 1.4,
                  }}
                  iconSize={10}
                />
              </RadarChart>
            </ResponsiveContainer>
          </div>

          <div className="cc-dim-table-section">
            <h3 className="cc-section-title">Dimension Table</h3>
            <DimensionTable candidates={compareList.slice(0, 4)} />
          </div>
        </div>
      )}

      {/* ── Narrative comparison ────────────────────────────────────────── */}
      {comparison?.narrativeComparison && (
        <div className="cc-narrative">
          <h3 className="cc-section-title">AI Narrative Analysis</h3>
          <p>{resolveIds(comparison.narrativeComparison, comparison.rankings, candidates)}</p>
        </div>
      )}

      {/* ── Action cards ────────────────────────────────────────────────── */}
      {compareList.length > 0 && (
        <>
          <h3 className="cc-section-title">Actions</h3>
          <div
            className="cc-compare-grid"
            style={{ gridTemplateColumns: `repeat(${Math.min(compareList.length, 4)}, minmax(200px, 1fr))` }}
          >
            {compareList.slice(0, 4).map((c) => {
              const isWinner = c.sessionId === winnerSessionId;
              return (
                <div key={c.sessionId} className={`cc-action-card${isWinner ? " winner" : ""}`}>
                  <div className="cc-action-name">
                    {c.aiRank?.rank && <span className="cc-rank-badge">#{c.aiRank.rank}</span>}
                    <span>{getDisplayName(c)}</span>
                    {isWinner && <span className="cc-winner-chip">Selected</span>}
                  </div>
                  <div className="cc-actions">
                    {reasonForSessionId === c.sessionId ? (
                      <>
                        <textarea
                          rows={2}
                          placeholder="Why this candidate? (optional)"
                          value={reasonText}
                          onChange={(e) => onReasonChange(e.target.value)}
                        />
                        <div className="cc-actions-row">
                          <button
                            type="button"
                            className="cc-btn ghost tiny"
                            onClick={() => { onSetReasonFor(null); onReasonChange(""); }}
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            className="cc-btn primary tiny"
                            onClick={() => onSelectWinner(c)}
                          >
                            Confirm
                          </button>
                        </div>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="cc-btn ghost tiny"
                          onClick={() => navigate(`/call-room/${c.sessionId}`)}
                        >
                          View Interview
                        </button>
                        <button
                          type="button"
                          className={`cc-btn tiny ${isWinner ? "ghost" : "primary"}`}
                          onClick={() => {
                            onSetReasonFor(c.sessionId);
                            onReasonChange(isWinner ? room?.selectedCandidate?.reason || "" : "");
                          }}
                        >
                          {isWinner ? "Update Pick" : "Pick This Candidate"}
                        </button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// ScoreCard sub-component
// ─────────────────────────────────────────────────────────────────────────────
const ScoreCard = ({
  candidate: c, breakdown: bd, color, isWinner, isRecommended,
  reasonText, reasonForSessionId, onSelectWinner, onReasonChange, onSetReasonFor, navigate,
}) => (
  <div className={`cc-score-card${isWinner ? " winner" : ""}${isRecommended ? " recommended" : ""}`}>
    <div className="cc-score-card-head" style={{ borderTopColor: color }}>
      <div>
        <h4>{getDisplayName(c)}</h4>
        {isRecommended && <span className="cc-ai-chip">AI Pick</span>}
        {isWinner && <span className="cc-winner-chip">Selected</span>}
      </div>
      <div className="cc-score-big" style={{ color }}>
        {fmtScore(c.aiRank?.compositeScore, 0)}
        <span>/100</span>
      </div>
    </div>

    <div className="cc-breakdown">
      {RADAR_DIMS.map(({ key, label }) => (
        <div className="cc-bd-row" key={key}>
          <span className="cc-bd-label">{label}</span>
          <div className="cc-bar">
            <div
              className="cc-bar-fill"
              style={{
                width: `${clamp(bd[key] ?? 0)}%`,
                background: color,
              }}
            />
          </div>
          <span className="cc-bd-val">{Math.round(clamp(bd[key] ?? 0))}</span>
        </div>
      ))}
    </div>

    {(c.aiRank?.strengths?.length > 0 || c.aiRank?.gaps?.length > 0) && (() => {
      // Drop gap chips that complain about the input data itself instead of
      // the candidate's performance. These leak through when the LLM was fed
      // a metrics dict with a 0/null field (e.g. "Missing technical theta",
      // "Unknown resilience index") — that's a data-pipeline gap, not
      // candidate feedback, and showing it to the recruiter is noise.
      const META_GAP = /^\s*(?:unknown|missing|n\/a|no data|not\s+available)\b/i;
      const realGaps = (c.aiRank.gaps || []).filter((g) => !META_GAP.test(String(g)));
      const realStrengths = (c.aiRank.strengths || []).filter((s) => !META_GAP.test(String(s)));
      if (realStrengths.length === 0 && realGaps.length === 0) return null;
      return (
        <div className="cc-chips-row">
          {realStrengths.slice(0, 3).map((s) => (
            <span key={s} className="cc-chip strength">{s}</span>
          ))}
          {realGaps.slice(0, 2).map((g) => (
            <span key={g} className="cc-chip gap">{g}</span>
          ))}
        </div>
      );
    })()}

    {c.aiRank?.justification && (
      <p className="cc-card-justification">{c.aiRank.justification}</p>
    )}
  </div>
);

// ─────────────────────────────────────────────────────────────────────────────
// DimensionTable sub-component
// ─────────────────────────────────────────────────────────────────────────────
const DimensionTable = ({ candidates }) => {
  const maxPerDim = useMemo(() => {
    const result = {};
    RADAR_DIMS.forEach(({ key }) => {
      result[key] = Math.max(
        ...candidates.map((c) => Number(c.aiRank?.compositeBreakdown?.[key] ?? 0))
      );
    });
    return result;
  }, [candidates]);

  return (
    <div className="cc-dim-table-wrap">
      <table className="cc-dim-table">
        <thead>
          <tr>
            <th>Dimension</th>
            {candidates.map((c, i) => (
              <th
                key={c.sessionId}
                style={{ color: CANDIDATE_COLORS[i] }}
                title={getDisplayName(c)}
              >
                {getDisplayName(c, { firstOnly: true })}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {RADAR_DIMS.map(({ key, label }) => (
            <tr key={key}>
              <td className="cc-dim-label">{label}</td>
              {candidates.map((c, i) => {
                const val = Number(c.aiRank?.compositeBreakdown?.[key] ?? null);
                const isTop = val === maxPerDim[key] && val > 0;
                return (
                  <td
                    key={c.sessionId}
                    className={`cc-dim-val${isTop ? " best" : ""}`}
                    style={isTop ? { background: `${CANDIDATE_COLORS[i]}22`, color: CANDIDATE_COLORS[i] } : {}}
                  >
                    {Number.isNaN(val) || val == null ? "—" : Math.round(val)}
                  </td>
                );
              })}
            </tr>
          ))}
          <tr className="cc-dim-total">
            <td>Composite</td>
            {candidates.map((c, i) => {
              const val = c.aiRank?.compositeScore;
              const maxVal = Math.max(...candidates.map((x) => Number(x.aiRank?.compositeScore ?? 0)));
              const isTop = Number(val) === maxVal && maxVal > 0;
              return (
                <td
                  key={c.sessionId}
                  className={`cc-dim-val${isTop ? " best" : ""}`}
                  style={isTop ? { background: `${CANDIDATE_COLORS[i]}22`, color: CANDIDATE_COLORS[i], fontWeight: 700 } : { fontWeight: 700 }}
                >
                  {val != null ? Math.round(Number(val)) : "—"}
                </td>
              );
            })}
          </tr>
        </tbody>
      </table>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// MetricCard sub-component
// ─────────────────────────────────────────────────────────────────────────────
const MetricCard = ({ label, value, sub, color }) => (
  <div className="cc-metric-card">
    <div className="cc-metric-card-val" style={{ color }}>{value}</div>
    <div className="cc-metric-card-label">{label}</div>
    <div className="cc-metric-card-sub">{sub}</div>
  </div>
);

export default CandidateComparison;
