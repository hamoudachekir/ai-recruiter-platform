/**
 * InterviewMediaPanel.jsx
 *
 * Recruiter media review section. Shows:
 *  1. Video player with range-request streaming + timeline markers
 *  2. Audio player fallback (if video unavailable)
 *  3. Integrity frame gallery (captured during analysis)
 *  4. Q&A "Watch Answer" jump buttons
 *
 * Props:
 *   roomId   {string}  - Mongo _id of the CallRoom (used as URL key)
 *   report   {object}  - Full analysis report (for timeline events + Q&A timestamps)
 *   room     {object}  - CallRoom document (optional, for metadata)
 */
import { useState, useEffect, useRef, useCallback } from "react";
import {
  getInterviewMedia,
  buildMediaUrl,
  getBehavioralInsights,
  startBehavioralInsightsAnalysis,
} from "../../services/analysisApi";
import RecordedVideoFaceMask from "../review/RecordedVideoFaceMask";
import LocalEmotionSummary from "../review/LocalEmotionSummary";
import "./InterviewMediaPanel.css";

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmtTime(sec) {
  if (sec == null || !Number.isFinite(Number(sec))) return "–";
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (h > 0)
    return `${h}:${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
  return `${m}:${String(ss).padStart(2, "0")}`;
}

const EVENT_CONFIG = {
  integrity_alert: { color: "#ef4444", icon: "🚨", label: "Integrity Alert" },
  absence: { color: "#f97316", icon: "👤", label: "Absence" },
  multiple_faces: { color: "#dc2626", icon: "👥", label: "Multiple Faces" },
  long_silence: { color: "#6366f1", icon: "🔇", label: "Silence" },
  strong_answer: { color: "#22c55e", icon: "✅", label: "Strong Answer" },
  acceptable_answer: { color: "#84cc16", icon: "✔", label: "Acceptable" },
  weak_answer: { color: "#f59e0b", icon: "⚠", label: "Weak Answer" },
  question: { color: "#3b82f6", icon: "❓", label: "Question" },
};

/** Build timeline events from report signals. */
function buildTimelineEvents(report) {
  const events = [];

  // Integrity alerts → timestamps from integrityAlerts
  const alerts = report?.integrityAlerts || [];
  alerts.forEach((a) => {
    const ts = a.timestamp ? new Date(a.timestamp).getTime() : null;
    const roomStart = null; // We don't have exact room start, so skip if no relative ts
    const type = a.type || "";
    let evType = "integrity_alert";
    if (type === "NO_FACE_DETECTED") evType = "absence";
    if (type === "MULTIPLE_FACES_DETECTED") evType = "multiple_faces";

    // Use questionId as a rough timestamp proxy: qN → N * 120 sec
    const qId = a.questionId || "";
    const qNum = parseInt(qId.replace(/\D/g, ""), 10) || 0;
    const approxTs = qNum > 0 ? qNum * 120 : null;

    if (approxTs !== null) {
      events.push({
        timestamp: approxTs,
        type: evType,
        label: EVENT_CONFIG[evType]?.label || a.type || "Alert",
        message: a.message || "",
      });
    }
  });

  // Long silences
  const silences = report?.audioAnalysis?.silenceEvents || 0;
  if (silences > 0) {
    events.push({
      timestamp: Math.max(60, (report?.durationSeconds || 300) * 0.4),
      type: "long_silence",
      label: "Long Silence",
      message: `${silences} silence event(s) detected`,
    });
  }

  // Q&A evaluations
  const qnaItems = report?.interviewQna?.items || [];
  const qEvals = report?.questionEvaluations || [];
  qnaItems.forEach((item, idx) => {
    const ev = qEvals[idx];
    const questionTs = item.askedAt ? null : idx * 120; // rough: 2 min per question
    const answerTs = questionTs !== null ? questionTs + 15 : null;

    if (questionTs !== null) {
      events.push({
        timestamp: questionTs,
        type: "question",
        label: `Q${idx + 1}`,
        message: (item.questionText || "").slice(0, 60) + "...",
        questionId: item.questionId,
      });
    }

    if (ev && answerTs !== null) {
      const qType =
        ev.answerQuality === "strong"
          ? "strong_answer"
          : ev.answerQuality === "insufficient"
            ? "weak_answer"
            : "acceptable_answer";
      events.push({
        timestamp: answerTs,
        type: qType,
        label: `Answer Q${idx + 1} (${ev.score}/100)`,
        message: (item.answerText || "").slice(0, 60) + "...",
        questionId: item.questionId,
        score: ev.score,
      });
    }
  });

  return events.sort((a, b) => a.timestamp - b.timestamp);
}

// ── Sub-components ────────────────────────────────────────────────────────────

function TimelineBar({ events, duration, currentTime, onSeek }) {
  const barRef = useRef(null);
  const usableDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;

  const handleClick = (e) => {
    if (!barRef.current || !usableDuration) return;
    const rect = barRef.current.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    onSeek(Math.max(0, Math.min(usableDuration, ratio * usableDuration)));
  };

  const playheadPct = usableDuration
    ? Math.max(0, Math.min(100, (currentTime / usableDuration) * 100))
    : 0;

  return (
    <div
      className="imp-timeline"
      ref={barRef}
      onClick={handleClick}
      title="Click to seek"
    >
      {/* Playhead */}
      {usableDuration > 0 && (
        <div
          className="imp-timeline__playhead"
          style={{ left: `${playheadPct}%` }}
        />
      )}

      {/* Markers */}
      {events.map((ev, i) => {
        const pct = usableDuration > 0 ? (ev.timestamp / usableDuration) * 100 : 0;
        const cfg = EVENT_CONFIG[ev.type] || EVENT_CONFIG.integrity_alert;
        return (
          <button
            key={i}
            className="imp-timeline__marker"
            style={{ left: `${pct}%`, background: cfg.color }}
            title={`${fmtTime(ev.timestamp)} — ${ev.label}: ${ev.message}`}
            onClick={(e) => {
              e.stopPropagation();
              onSeek(ev.timestamp);
            }}
          />
        );
      })}
    </div>
  );
}

function EventLegend({ events }) {
  if (!events.length) return null;
  const seen = new Set();
  const types = events
    .map((e) => e.type)
    .filter((t) => {
      if (seen.has(t)) return false;
      seen.add(t);
      return true;
    });

  return (
    <div className="imp-legend">
      {types.map((t) => {
        const cfg = EVENT_CONFIG[t];
        if (!cfg) return null;
        return (
          <span key={t} className="imp-legend__item">
            <span
              className="imp-legend__dot"
              style={{ background: cfg.color }}
            />
            {cfg.label}
          </span>
        );
      })}
    </div>
  );
}

function EventList({ events, onSeek }) {
  const [collapsed, setCollapsed] = useState(true);
  const shown = collapsed ? events.slice(0, 5) : events;

  if (!events.length) return null;

  return (
    <div className="imp-events">
      <div className="imp-events__header">
        <h4 className="imp-events__title">📋 Timeline Events</h4>
        {events.length > 5 && (
          <button
            className="imp-events__toggle"
            onClick={() => setCollapsed((c) => !c)}
          >
            {collapsed ? `Show all ${events.length}` : "Show less"}
          </button>
        )}
      </div>
      <div className="imp-events__list">
        {shown.map((ev, i) => {
          const cfg = EVENT_CONFIG[ev.type] || EVENT_CONFIG.integrity_alert;
          return (
            <div key={i} className="imp-event-row">
              <span className="imp-event-row__icon">{cfg.icon}</span>
              <button
                className="imp-event-row__ts"
                onClick={() => onSeek(ev.timestamp)}
                title="Jump to this moment"
              >
                {fmtTime(ev.timestamp)}
              </button>
              <span
                className="imp-event-row__label"
                style={{ color: cfg.color }}
              >
                {ev.label}
              </span>
              <span className="imp-event-row__msg">{ev.message}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function FramesGallery({ roomId, frames, onSeek, duration }) {
  const [enlarged, setEnlarged] = useState(null);
  if (!frames || frames.length === 0) return null;

  return (
    <div className="imp-frames">
      <h4 className="imp-frames__title">
        🖼 Integrity Snapshots ({frames.length})
      </h4>
      <p className="imp-frames__sub">
        Frames captured during analysis. Click to enlarge or jump to that
        moment.
      </p>
      <div className="imp-frames__grid">
        {frames.map((frame, i) => {
          const frameUrl = buildMediaUrl(
            roomId,
            `frame/${encodeURIComponent(frame.filename)}`,
          );
          // Try to extract timestamp from filename: frame_NNNN.jpg → index * (duration / total)
          const approxTs =
            duration && frames.length > 0
              ? (frame.index / frames.length) * duration
              : null;

          return (
            <div key={i} className="imp-frame-card">
              <img
                src={frameUrl}
                alt={`Frame ${frame.index}`}
                className="imp-frame-card__img"
                loading="lazy"
                onClick={() => setEnlarged(frame)}
                onError={(e) => {
                  e.target.style.display = "none";
                }}
              />
              <div className="imp-frame-card__info">
                <span className="imp-frame-card__num">#{frame.index}</span>
                {approxTs !== null && (
                  <span className="imp-frame-card__ts">
                    {fmtTime(approxTs)}
                  </span>
                )}
              </div>
              {approxTs !== null && (
                <button
                  className="imp-frame-card__jump"
                  onClick={() => onSeek(approxTs)}
                  title={`Jump to ${fmtTime(approxTs)}`}
                >
                  ▶ Jump
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* Lightbox */}
      {enlarged && (
        <div className="imp-lightbox" onClick={() => setEnlarged(null)}>
          <div
            className="imp-lightbox__inner"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="imp-lightbox__close"
              onClick={() => setEnlarged(null)}
            >
              ✕
            </button>
            <img
              src={buildMediaUrl(
                roomId,
                `frame/${encodeURIComponent(enlarged.filename)}`,
              )}
              alt={`Frame ${enlarged.index}`}
              className="imp-lightbox__img"
            />
            <p className="imp-lightbox__caption">
              Frame #{enlarged.index} — {enlarged.filename}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Resolve the recording-relative start time (seconds) of a candidate answer.
 * Tries, in order: an explicit numeric field, the matching transcript segment,
 * the ISO answer time minus the recording start, then a rough estimate.
 * Returns { sec, exact } so the UI can show "~" only when it's a guess.
 */
function resolveAnswerSeconds(item, idx, total, segments, recordingStartMs, durationSec) {
  // 1) Explicit numeric recording-relative seconds from the backend.
  for (const k of ["answerStartSec", "answerStart", "startSec", "answerTimestampSec"]) {
    const v = Number(item?.[k]);
    if (Number.isFinite(v) && v >= 0) return { sec: v, exact: true };
  }

  // 2) Match the answer text to a transcript segment (segment.start is already
  //    relative to the recording/video start).
  const answer = String(item?.answerText || "").trim().toLowerCase();
  if (answer && Array.isArray(segments) && segments.length) {
    const needle = answer.slice(0, 24);
    const seg = segments.find((s) => {
      const t = String(s?.text || "").trim().toLowerCase();
      return t && (t.includes(needle) || needle.includes(t.slice(0, 24)));
    });
    const start = Number(seg?.start);
    if (Number.isFinite(start) && start >= 0) return { sec: start, exact: true };
  }

  // 3) ISO answer/asked time minus the recording start.
  const iso = item?.answeredAt || item?.askedAt;
  if (iso && recordingStartMs) {
    const t = new Date(iso).getTime();
    if (Number.isFinite(t)) {
      const sec = (t - recordingStartMs) / 1000;
      if (sec >= 0 && sec < 24 * 3600) return { sec, exact: true };
    }
  }

  // 4) No real timing → spread answers evenly across the ACTUAL recording
  //    length so estimates never exceed the video. (idx+0.5) puts each answer
  //    at the midpoint of its slice. Falls back to 2 min/question only if the
  //    duration is unknown.
  if (Number.isFinite(durationSec) && durationSec > 0 && total > 0) {
    const sec = ((idx + 0.5) / total) * durationSec;
    return { sec: Math.max(0, Math.min(sec, durationSec - 0.5)), exact: false };
  }
  return { sec: idx * 120 + 15, exact: false };
}

function QnAJumpList({ qnaItems, qEvals, onSeek, segments, recordingStartMs, duration }) {
  if (!qnaItems || qnaItems.length === 0) return null;

  return (
    <div className="imp-qna-jump">
      <h4 className="imp-qna-jump__title">❓ Watch Candidate Answers</h4>
      <p className="imp-qna-jump__sub">
        Jump directly to a candidate answer in the recording.
      </p>
      <div className="imp-qna-jump__list">
        {qnaItems.map((item, idx) => {
          const ev = qEvals?.[idx];
          const { sec, exact } = resolveAnswerSeconds(
            item,
            idx,
            qnaItems.length,
            segments,
            recordingStartMs,
            duration,
          );
          const quality = ev?.answerQuality;
          const score = ev?.score;

          return (
            <div key={item.questionId || idx} className="imp-qna-row">
              <span className="imp-qna-row__num">Q{idx + 1}</span>
              <div className="imp-qna-row__text">
                <p className="imp-qna-row__question">
                  {(item.questionText || "Question").slice(0, 80)}
                </p>
                {score != null && (
                  <span
                    className={`imp-qna-row__badge imp-qna-row__badge--${quality || "acceptable"}`}
                  >
                    {score}/100 · {quality || "–"}
                  </span>
                )}
              </div>
              <button
                className="imp-qna-row__jump"
                onClick={() => onSeek(sec)}
                title={`Jump to ${exact ? "" : "~"}${fmtTime(sec)} in the recording`}
              >
                ▶ Watch Answer {exact ? `(${fmtTime(sec)})` : `(~${fmtTime(sec)})`}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const BEHAVIORAL_UI_ENABLED =
  import.meta.env.VITE_ENABLE_BEHAVIORAL_INSIGHTS !== "0";
const BEHAVIORAL_OUTPUT_LABEL = "Non-deterministic advisory behavioral signals";

const BEHAVIORAL_EVENT_CONFIG = {
  positive: {
    icon: "😊",
    label: "Engagement Variation",
    color: "#22c55e",
    heat: "positive",
  },
  stress: {
    icon: "〰️",
    label: "Possible Hesitation",
    color: "#f97316",
    heat: "elevated",
  },
  attention_loss: {
    icon: "👀",
    label: "Attention Variation",
    color: "#3b82f6",
    heat: "moderate",
  },
  silence_correlation: {
    icon: "🔇",
    label: "Possible Hesitation During Silence",
    color: "#6366f1",
    heat: "moderate",
  },
  neutral: {
    icon: "😐",
    label: "Neutral Behavioral Signal",
    color: "#94a3b8",
    heat: "neutral",
  },
};

function normalizeBehavioralSignal(signal = "neutral") {
  const normalized = String(signal).toLowerCase();
  if (normalized.includes("attention")) return "attention_loss";
  if (normalized.includes("silence")) return "silence_correlation";
  if (normalized.includes("positive") || normalized.includes("engagement"))
    return "positive";
  if (normalized.includes("stress") || normalized.includes("hesitation"))
    return "stress";
  return "neutral";
}

function normalizeBehavioralEvents(payload) {
  const events = payload?.events || payload?.behavioralEvents || [];
  return events
    .map((event, index) => {
      const type = normalizeBehavioralSignal(
        event.dominantEmotion || event.type || event.signal,
      );
      const cfg =
        BEHAVIORAL_EVENT_CONFIG[type] || BEHAVIORAL_EVENT_CONFIG.neutral;
      const rawConfidence = Number(
        event.confidence ?? event.confidenceEstimate ?? 0,
      );
      const confidence =
        rawConfidence > 1
          ? Math.round(rawConfidence)
          : Math.round(rawConfidence * 100);
      return {
        id: `${type}-${event.timestamp ?? index}-${index}`,
        timestamp: Number(event.timestamp ?? event.startTimestamp ?? 0),
        type,
        label: cfg.label,
        icon: cfg.icon,
        color: cfg.color,
        heat: cfg.heat,
        confidence: Number.isFinite(confidence)
          ? Math.max(0, Math.min(100, confidence))
          : 0,
        attentionScore: Number(event.attentionScore ?? 0),
        speakingEnergy: event.speakingEnergy || "medium",
        advisoryOnly: event.advisoryOnly !== false,
      };
    })
    .sort((a, b) => a.timestamp - b.timestamp);
}

function findActiveBehavioralEvent(events, currentTime) {
  if (!events.length) return null;
  return (
    events.reduce((closest, event) => {
      const distance = Math.abs(event.timestamp - currentTime);
      if (distance > 6) return closest;
      if (!closest || distance < closest.distance) return { event, distance };
      return closest;
    }, null)?.event || null
  );
}

function BehavioralInsightsPanel({
  events,
  summary,
  loading,
  error,
  analyzing,
  disabled,
  duration,
  currentTime,
  onSeek,
  onGenerate,
}) {
  const safeSummary = summary || {
    avgStressLevel: 0,
    attentionConsistency: 0,
    emotionVariability: "low",
    stressSpikes: 0,
    attentionLossEvents: 0,
  };

  return (
    <div className="imp-behavioral-panel">
      <div className="imp-behavioral-panel__header">
        <div>
          <h4 className="imp-behavioral-panel__title">
            Behavioral Insights Overlay
          </h4>
          <p className="imp-behavioral-panel__sub">
            {BEHAVIORAL_OUTPUT_LABEL} · Recruiter-only · Optional ·
            Advisory-only · No scoring impact
          </p>
        </div>
        {!loading && !disabled && events.length === 0 && (
          <button
            type="button"
            className="imp-behavioral-panel__action"
            onClick={onGenerate}
            disabled={analyzing}
          >
            {analyzing ? "Generating…" : "Generate Overlay"}
          </button>
        )}
      </div>

      <div className="imp-behavioral-disclaimer">
        This overlay is separate from deterministic evaluation. It never changes
        overall score, technical score, integrity score, confidence decisions,
        decision traces, bias reports, replay validation, ML calibration, or
        hiring decisions.
      </div>

      {disabled && (
        <div className="imp-behavioral-empty">
          Behavioral overlay is disabled by feature flag.
        </div>
      )}

      {loading && (
        <div className="imp-behavioral-status">
          <span className="imp-state__spinner" />
          <span>Loading optional advisory behavioral signals…</span>
        </div>
      )}

      {error && !disabled && (
        <div className="imp-behavioral-advisory">
          Behavioral overlay is unavailable. Deterministic report generation is
          unaffected.
        </div>
      )}

      {!loading && !error && !disabled && events.length === 0 && (
        <div className="imp-behavioral-empty">
          No advisory behavioral signal events are available yet. You may
          generate them in the background.
        </div>
      )}

      {events.length > 0 && (
        <>
          <div className="imp-behavioral-summary">
            <div className="imp-behavioral-summary__item">
              <span className="imp-behavioral-summary__label">
                Advisory summary
              </span>
              <span>
                Behavioral fluctuation level:{" "}
                {safeSummary.emotionVariability || "low"}
              </span>
            </div>
            <div className="imp-behavioral-summary__grid">
              <span>
                Possible hesitation signals: {safeSummary.stressSpikes ?? 0}
              </span>
              <span>
                Attention variation events:{" "}
                {safeSummary.attentionLossEvents ?? 0}
              </span>
              <span>
                Attention consistency:{" "}
                {Math.round((safeSummary.attentionConsistency || 0) * 100)}%
              </span>
              <span>
                Average hesitation-like signal:{" "}
                {Math.round((safeSummary.avgStressLevel || 0) * 100)}%
              </span>
            </div>
          </div>

          <div className="imp-behavioral-track">
            <p className="imp-behavioral-track__label">
              Advisory behavioral timeline — {fmtTime(currentTime)} /{" "}
              {fmtTime(duration)}
            </p>
            <div className="imp-behavioral-track__bar">
              {events.map((event) => {
                const pct =
                  duration > 0 ? (event.timestamp / duration) * 100 : 0;
                return (
                  <button
                    key={event.id}
                    type="button"
                    className="imp-behavioral-track__marker"
                    style={{
                      left: `${Math.max(0, Math.min(100, pct))}%`,
                      background: event.color,
                    }}
                    title={`${fmtTime(event.timestamp)} → ${event.label} · confidence estimate ${event.confidence}%`}
                    onClick={() => onSeek(event.timestamp)}
                  />
                );
              })}
            </div>
          </div>

          <div className="imp-behavioral-heatmap">
            <p className="imp-behavioral-track__label">
              Heatmap timeline — advisory signal density
            </p>
            <div className="imp-behavioral-heatmap__bar">
              {events.map((event) => {
                const pct =
                  duration > 0 ? (event.timestamp / duration) * 100 : 0;
                return (
                  <span
                    key={`${event.id}-heat`}
                    className={`imp-behavioral-heatmap__segment imp-behavioral-heatmap__segment--${event.heat}`}
                    style={{ left: `${Math.max(0, Math.min(100, pct))}%` }}
                    title={`${fmtTime(event.timestamp)} → ${event.label}`}
                  />
                );
              })}
            </div>
          </div>

          <div className="imp-behavioral-events">
            {events.slice(0, 10).map((event) => (
              <button
                key={`${event.id}-row`}
                type="button"
                className="imp-behavioral-event"
                onClick={() => onSeek(event.timestamp)}
              >
                <span className="imp-behavioral-event__time">
                  {fmtTime(event.timestamp)}
                </span>
                <span>
                  → {event.label} · confidence estimate {event.confidence}%
                </span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function InterviewMediaPanel({ roomId, report, room }) {
  const videoRef = useRef(null);
  // Holds a seek target requested while the <video> was unmounted (e.g. from
  // the "Watch Answers" tab). Flushed once the video element is ready.
  const pendingSeekRef = useRef(null);

  const flushPendingSeek = useCallback((el) => {
    const v = el || videoRef.current;
    if (!v || pendingSeekRef.current == null) return;
    // Wait until the element has metadata; otherwise setting currentTime is
    // ignored and we'd lose the queued target. onLoadedMetadata/onCanPlay retry.
    if (v.readyState < 1) return;
    let ts = pendingSeekRef.current;
    pendingSeekRef.current = null;
    // Clamp to the real video length so an over-estimate never lands past the
    // end (which would snap to 0 / show a black frame).
    const dur = Number(v.duration);
    if (Number.isFinite(dur) && dur > 0) {
      ts = Math.max(0, Math.min(ts, dur - 0.5));
    }
    try {
      v.currentTime = ts;
      v.play().catch(() => {});
    } catch {
      /* ignore */
    }
  }, []);

  const setVideoRef = useCallback(
    (el) => {
      videoRef.current = el;
      if (el) flushPendingSeek(el);
    },
    [flushPendingSeek],
  );

  const [media, setMedia] = useState(null);
  const [mediaLoading, setMediaLoading] = useState(false);
  const [mediaError, setMediaError] = useState(null);
  const [videoError, setVideoError] = useState(null);
  const [videoLoading, setVideoLoading] = useState(true);
  const [videoBlobUrl, setVideoBlobUrl] = useState(null);

  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(report?.durationSeconds || 0);
  // Blendshape samples collected by RecordedVideoFaceMask, used to drive the
  // LocalEmotionSummary section below the video. Capped to keep memory
  // bounded on long interviews.
  const [emotionSamples, setEmotionSamples] = useState([]);
  const handleEmotionSample = useCallback((sample) => {
    if (!sample) return;
    setEmotionSamples((prev) => {
      // Replace any prior sample within 200ms of the same timestamp so
      // re-watching a section overwrites instead of duplicating.
      const filtered = prev.filter(
        (p) => Math.abs(p.timestamp - sample.timestamp) > 0.2,
      );
      const next = [...filtered, sample];
      if (next.length > 1500) next.splice(0, next.length - 1500);
      return next;
    });
  }, []);
  const [playing, setPlaying] = useState(false);

  const [activeTab, setActiveTab] = useState("video"); // 'video' | 'frames' | 'answers'
  const [showBehavioralInsights, setShowBehavioralInsights] = useState(false);
  const [behavioralPayload, setBehavioralPayload] = useState(null);
  const [behavioralLoading, setBehavioralLoading] = useState(false);
  const [behavioralError, setBehavioralError] = useState(null);
  const [behavioralAnalyzing, setBehavioralAnalyzing] = useState(false);
  const [behavioralDisabled, setBehavioralDisabled] = useState(
    !BEHAVIORAL_UI_ENABLED,
  );

  const fetchBehavioralInsights = useCallback(
    async ({ silent = false } = {}) => {
      if (!roomId || !BEHAVIORAL_UI_ENABLED) return;
      if (!silent) setBehavioralLoading(true);
      setBehavioralError(null);
      try {
        const data = await getBehavioralInsights(roomId);
        setBehavioralPayload(data);
        setBehavioralDisabled(
          data?.status === "disabled" || data?.enabled === false,
        );
      } catch (err) {
        setBehavioralError(
          err.message || "Advisory behavioral overlay is unavailable.",
        );
      } finally {
        if (!silent) setBehavioralLoading(false);
      }
    },
    [roomId],
  );

  useEffect(() => {
    if (!showBehavioralInsights || behavioralPayload || behavioralLoading)
      return;
    fetchBehavioralInsights();
  }, [
    showBehavioralInsights,
    behavioralPayload,
    behavioralLoading,
    fetchBehavioralInsights,
  ]);

  const handleGenerateBehavioralInsights = async () => {
    if (!roomId || behavioralAnalyzing || behavioralDisabled) return;
    setBehavioralAnalyzing(true);
    setBehavioralError(null);
    try {
      const result = await startBehavioralInsightsAnalysis(roomId);
      if (result?.status === "disabled") {
        setBehavioralDisabled(true);
        setBehavioralPayload(result);
        setBehavioralAnalyzing(false);
        return;
      }

      let attempts = 0;
      const poll = async () => {
        attempts += 1;
        await fetchBehavioralInsights({ silent: true });
        if (attempts < 6) {
          window.setTimeout(poll, 3500);
        } else {
          setBehavioralAnalyzing(false);
        }
      };
      window.setTimeout(poll, 2500);
    } catch (err) {
      setBehavioralAnalyzing(false);
      setBehavioralError(
        err.message || "Could not start advisory behavioral overlay.",
      );
    }
  };

  // Fetch media manifest
  useEffect(() => {
    if (!roomId) return;
    setMediaLoading(true);
    setMediaError(null);
    setVideoError(null);
    setVideoLoading(true);
    setVideoBlobUrl(null);
    getInterviewMedia(roomId)
      .then(setMedia)
      .catch((err) => setMediaError(err.message))
      .finally(() => setMediaLoading(false));
  }, [roomId]);

  // Fetch video with authentication (blob URL for <video> tag)
  useEffect(() => {
    if (!roomId || !media?.video?.available) return;

    const fetchVideoWithAuth = async () => {
      setVideoLoading(true);
      setVideoError(null);

      try {
        const token = localStorage.getItem("token");
        const videoUrl = buildMediaUrl(roomId, "video");

        const response = await fetch(videoUrl, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });

        if (!response.ok) {
          if (response.status === 401) {
            throw new Error("Authentication required. Please log in again.");
          }
          throw new Error(`Failed to load video: ${response.status}`);
        }

        const blob = await response.blob();
        const blobUrl = URL.createObjectURL(blob);
        setVideoBlobUrl(blobUrl);
      } catch (err) {
        console.error("[Video] Failed to fetch video:", err);
        setVideoError(err.message);
      } finally {
        setVideoLoading(false);
      }
    };

    fetchVideoWithAuth();

    // Cleanup blob URL on unmount
    return () => {
      if (videoBlobUrl) {
        URL.revokeObjectURL(videoBlobUrl);
      }
    };
  }, [roomId, media?.video?.available]);

  // Probe the recording's duration off-DOM as soon as the blob is available, so
  // the "Watch Answers" tab knows the real length and spreads its estimated
  // jump times within it — even before the recruiter opens the Video tab.
  useEffect(() => {
    if (!videoBlobUrl || duration > 0) return;
    const probe = document.createElement("video");
    probe.preload = "metadata";
    probe.muted = true;
    let done = false;
    const finish = (d) => {
      if (!done && Number.isFinite(d) && d > 0) {
        done = true;
        setDuration(d);
      }
      probe.src = "";
    };
    probe.onloadedmetadata = () => {
      const d = Number(probe.duration);
      if (Number.isFinite(d) && d > 0) return finish(d);
      // Raw WebM may report Infinity — force a scrub to compute it.
      probe.onseeked = () => finish(Number(probe.duration));
      try {
        probe.currentTime = 1e9;
      } catch {
        probe.src = "";
      }
    };
    probe.onerror = () => {
      probe.src = "";
    };
    probe.src = videoBlobUrl;
    return () => {
      probe.onloadedmetadata = null;
      probe.onseeked = null;
      probe.onerror = null;
      probe.src = "";
    };
  }, [videoBlobUrl, duration]);

  const handleSeek = useCallback((ts) => {
    const target = Math.max(0, Number(ts) || 0);
    // Always switch to the video tab — the <video> only renders there, so a
    // seek requested from the Frames / Watch-Answers tabs must mount it first.
    setActiveTab("video");
    const v = videoRef.current;
    if (v && v.readyState >= 1) {
      // Video already mounted and has metadata → seek immediately.
      try {
        v.currentTime = target;
        v.play().catch(() => {});
      } catch {
        pendingSeekRef.current = target;
      }
    } else {
      // Video not mounted yet (or still loading) → queue; flushed on
      // setVideoRef / onLoadedMetadata / onCanPlay.
      pendingSeekRef.current = target;
    }
  }, []);

  const togglePlay = () => {
    if (!videoRef.current) return;
    if (videoRef.current.paused) {
      videoRef.current.play().catch(() => {});
    } else {
      videoRef.current.pause();
    }
  };

  const timelineEvents = buildTimelineEvents(report);
  const behavioralEvents = normalizeBehavioralEvents(behavioralPayload);
  const behavioralSummary = behavioralPayload?.summary || null;
  const activeBehavioralEvent = showBehavioralInsights
    ? findActiveBehavioralEvent(behavioralEvents, currentTime)
    : null;
  // Drop phantom duplicate questions (e.g. the agent greeting re-sent before
  // the candidate answered) and keep qnaItems / qEvals index-aligned.
  const _rawQna = report?.interviewQna?.items || [];
  const _rawEvals = report?.questionEvaluations || [];
  const _normQ = (t) =>
    String(t || "").trim().toLowerCase().replace(/\s+/g, " ").slice(0, 160);
  const _answeredQ = new Set(
    _rawQna
      .filter((it) => String(it.answerText || "").trim())
      .map((it) => _normQ(it.questionText)),
  );
  const _keepMask = _rawQna.map(
    (it) =>
      !!String(it.answerText || "").trim() ||
      !_answeredQ.has(_normQ(it.questionText)),
  );
  const qnaItems = _rawQna.filter((_, i) => _keepMask[i]);
  const qEvals = _rawEvals.filter((_, i) =>
    i < _keepMask.length ? _keepMask[i] : true,
  );
  // Transcript segments carry recording-relative start times — used to land the
  // "Watch Answer" jumps on the real moment instead of a fixed estimate.
  const transcriptSegments = Array.isArray(report?.transcript?.segments)
    ? report.transcript.segments
    : Array.isArray(report?.transcript)
      ? report.transcript
      : [];
  const recordingStartMs = (() => {
    const iso =
      report?.recordingStartedAt ||
      room?.recordingStartedAt ||
      report?.interviewQna?.recordingStartedAt;
    const t = iso ? new Date(iso).getTime() : NaN;
    return Number.isFinite(t) ? t : null;
  })();

  if (!roomId) return null;

  const videoUrl = videoBlobUrl || null;
  const directVideoUrl = media?.video?.available
    ? buildMediaUrl(roomId, "video")
    : null;

  return (
    <section className="imp-root">
      {/* Header */}
      <div className="imp-header">
        <div>
          <p className="imp-eyebrow">Media Review</p>
          <h3 className="imp-title">Interview Recording</h3>
          <p className="imp-subtitle">
            Deterministic evaluation remains separate · Secure streaming · Click
            timeline to seek
          </p>
        </div>
        {media?.video?.sizeMb > 0 && (
          <div className="imp-meta">
            <span className="imp-meta__item">🎬 {report?.duration || "–"}</span>
            <span className="imp-meta__item">💾 {media.video.sizeMb} MB</span>
            {media?.video?.filename && (
              <span className="imp-meta__item">📄 {media.video.filename}</span>
            )}
          </div>
        )}
      </div>

      {/* Loading / error states */}
      {mediaLoading && (
        <div className="imp-state">
          <div className="imp-state__spinner" />
          <p>Loading media…</p>
        </div>
      )}

      {mediaError && (
        <div className="imp-state imp-state--error">
          <span>⚠️</span>
          <p>Could not load media: {mediaError}</p>
        </div>
      )}

      {/* Main content */}
      {!mediaLoading && (
        <>
          {/* Tabs */}
          <div className="imp-tabs">
            <button
              className={`imp-tab ${activeTab === "video" ? "imp-tab--active" : ""}`}
              onClick={() => setActiveTab("video")}
            >
              🎬 Video
            </button>
            {media?.frames?.length > 0 && (
              <button
                className={`imp-tab ${activeTab === "frames" ? "imp-tab--active" : ""}`}
                onClick={() => setActiveTab("frames")}
              >
                🖼 Frames ({media.frames.length})
              </button>
            )}
            {qnaItems.length > 0 && (
              <button
                className={`imp-tab ${activeTab === "answers" ? "imp-tab--active" : ""}`}
                onClick={() => setActiveTab("answers")}
              >
                ❓ Watch Answers
              </button>
            )}
          </div>

          {/* Video tab */}
          {activeTab === "video" && (
            <div className="imp-video-section">
              {videoUrl ? (
                <>
                  <div className="imp-video-wrap">
                    {videoLoading && (
                      <div className="imp-video-loading">
                        <div className="imp-video-loading__spinner"></div>
                        <p>Loading video...</p>
                      </div>
                    )}
                    {videoError && (
                      <div className="imp-video-error">
                        <p className="imp-video-error__icon">⚠️</p>
                        <p className="imp-video-error__text">{videoError}</p>
                        <a
                          href={directVideoUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="imp-video-error__link"
                        >
                          Open video in new tab
                        </a>
                      </div>
                    )}
                    <video
                      ref={setVideoRef}
                      className={`imp-video ${videoError ? "imp-video--hidden" : ""}`}
                      src={videoUrl}
                      controls
                      preload="metadata"
                      onLoadedMetadata={(e) => {
                        const v = e.target;
                        const d = Number(v.duration);
                        if (Number.isFinite(d) && d > 0) {
                          setDuration(d);
                          setVideoLoading(false);
                          flushPendingSeek(v);
                          return;
                        }
                        // WebM recordings produced by MediaRecorder commonly
                        // report duration = Infinity until the browser has
                        // scrubbed past the end of the file. Force a seek to
                        // a huge timestamp, wait for the resulting `seeked`
                        // event (the real duration is now known), then seek
                        // to the queued target (or back to the start).
                        const onSeeked = () => {
                          v.removeEventListener("seeked", onSeeked);
                          const realD = Number(v.duration);
                          if (Number.isFinite(realD) && realD > 0) {
                            setDuration(realD);
                          }
                          setVideoLoading(false);
                          if (pendingSeekRef.current != null) {
                            flushPendingSeek(v);
                          } else {
                            try {
                              v.currentTime = 0;
                            } catch (_err) {
                              /* ignore */
                            }
                          }
                        };
                        v.addEventListener("seeked", onSeeked);
                        try {
                          v.currentTime = 1e9;
                        } catch (_err) {
                          v.removeEventListener("seeked", onSeeked);
                          setVideoLoading(false);
                        }
                      }}
                      onCanPlay={(e) => flushPendingSeek(e.target)}
                      onDurationChange={(e) => {
                        const d = Number(e.target.duration);
                        if (Number.isFinite(d) && d > 0) setDuration(d);
                      }}
                      onTimeUpdate={(e) =>
                        setCurrentTime(e.target.currentTime || 0)
                      }
                      onPlay={() => setPlaying(true)}
                      onPause={() => setPlaying(false)}
                      onError={(e) => {
                        setVideoLoading(false);
                        const error = e.target.error;
                        let message = "Failed to load video";
                        if (error) {
                          switch (error.code) {
                            case 1:
                              message = "Video loading aborted";
                              break;
                            case 2:
                              message = "Network error - check connection";
                              break;
                            case 3:
                              message =
                                "Video decoding error - format not supported";
                              break;
                            case 4:
                              message = "Video not found or access denied";
                              break;
                          }
                        }
                        setVideoError(message);
                        console.error(
                          "[Video] Error loading video:",
                          videoUrl,
                          error,
                        );
                      }}
                    >
                      Your browser does not support the video element.
                    </video>
                    {/* Live MediaPipe face-mesh overlay with real-time
                        sentiment readout from blendshapes. Runs entirely
                        in the browser; advisory only. Emits samples to
                        the LocalEmotionSummary below the video. */}
                    <RecordedVideoFaceMask
                      videoEl={videoRef.current}
                      enabled
                      onSample={handleEmotionSample}
                    />
                  </div>

                  {/* Timeline bar */}
                  {timelineEvents.length > 0 && (
                    <div className="imp-timeline-section">
                      <p className="imp-timeline-label">
                        Timeline — {fmtTime(currentTime)} / {fmtTime(duration)}
                      </p>
                      <TimelineBar
                        events={timelineEvents}
                        duration={duration}
                        currentTime={currentTime}
                        onSeek={handleSeek}
                      />
                      <EventLegend events={timelineEvents} />
                    </div>
                  )}

                  {/* Event list */}
                  <EventList events={timelineEvents} onSeek={handleSeek} />

                  {/* Local emotion summary — driven by MediaPipe blendshape
                      samples collected while the recruiter plays the video */}
                  <LocalEmotionSummary
                    samples={emotionSamples}
                    videoEl={videoRef.current}
                    duration={duration}
                  />
                </>
              ) : (
                <div className="imp-unavailable">
                  <span className="imp-unavailable__icon">🎬</span>
                  <p className="imp-unavailable__text">
                    Interview recording unavailable.
                    {media &&
                      !media.available &&
                      " No media files were found for this interview."}
                  </p>
                </div>
              )}

              {/* Audio fallback */}
              {!videoUrl && media?.audio?.available && (
                <div className="imp-audio-section">
                  <h4 className="imp-audio-title">🔊 Audio Playback</h4>
                  <audio
                    controls
                    preload="metadata"
                    src={buildMediaUrl(roomId, "audio")}
                    className="imp-audio"
                  >
                    Your browser does not support audio playback.
                  </audio>
                </div>
              )}
            </div>
          )}

          {/* Frames tab */}
          {activeTab === "frames" && (
            <FramesGallery
              roomId={roomId}
              frames={media?.frames || []}
              onSeek={handleSeek}
              duration={duration}
            />
          )}

          {/* Watch Answers tab */}
          {activeTab === "answers" && (
            <QnAJumpList
              qnaItems={qnaItems}
              qEvals={qEvals}
              onSeek={handleSeek}
              segments={transcriptSegments}
              recordingStartMs={recordingStartMs}
              duration={duration}
            />
          )}
        </>
      )}
    </section>
  );
}
