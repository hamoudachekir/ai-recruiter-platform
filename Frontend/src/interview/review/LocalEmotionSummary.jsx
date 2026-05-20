/**
 * LocalEmotionSummary
 *
 * Compact, recruiter-facing emotion summary built entirely from MediaPipe
 * blendshape samples collected by RecordedVideoFaceMask as the recruiter
 * plays the recording. Renders a hero metrics row and reuses the existing
 * EmotionBreakdown / EmotionOverTimeChart / PeakMoments components from
 * EmotionDashboard. Advisory only — never affects scoring.
 */
import { useMemo } from "react";

import {
  EmotionBreakdown,
  EmotionOverTimeChart,
  PeakMoments,
  EMOTION_KEYS,
  EMOTION_EMOJI,
  EMOTION_COLORS,
  capitalize,
  formatTime,
} from "../report/EmotionDashboard";

import "./LocalEmotionSummary.css";

const BUCKET_SIZE_SEC = 15;
const PEAK_MIN_INTENSITY = 0.28;
const PEAK_MIN_SPACING_SEC = 8;
const DOMINANT_MIN_AVG_PCT = 4; // below this we report "neutral / unread"
const PEAK_LABELS = {
  happy: "Positive Engagement",
  surprise: "Surprise / Interest",
  sad: "Behavioral Dip",
  fear: "Hesitation",
  angry: "Tension",
  disgust: "Discomfort",
  neutral: "Neutral Composure",
};

const safe = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const clampPct = (v) => Math.max(0, Math.min(100, Math.round(v)));

const buildSummary = (samples, duration) => {
  const valid = (samples || []).filter(
    (s) => s && s.probs && Number.isFinite(s.timestamp),
  );
  const total = valid.length;
  if (!total) {
    return {
      averages: Object.fromEntries(EMOTION_KEYS.map((k) => [k, 0])),
      timeline: [],
      peaks: [],
      sampleCount: 0,
      coverageSec: 0,
      dominant: "neutral",
      dominantPct: 0,
      stressScore: 0,
      positivityScore: 0,
      engagementArc: "stable",
    };
  }

  // ── Averages
  const sums = Object.fromEntries(EMOTION_KEYS.map((k) => [k, 0]));
  for (const s of valid) {
    for (const k of EMOTION_KEYS) sums[k] += safe(s.probs[k]);
  }
  const averagesFloat = Object.fromEntries(
    EMOTION_KEYS.map((k) => [k, (sums[k] / total) * 100]),
  );
  const averages = Object.fromEntries(
    EMOTION_KEYS.map((k) => [k, Math.round(averagesFloat[k])]),
  );

  // ── Dominant emotion (clear winner over neutral, with floor)
  let dominant = "neutral";
  let dominantAvg = averagesFloat.neutral;
  for (const k of EMOTION_KEYS) {
    if (k === "neutral") continue;
    if (averagesFloat[k] > dominantAvg) {
      dominant = k;
      dominantAvg = averagesFloat[k];
    }
  }
  if (dominant !== "neutral" && dominantAvg < DOMINANT_MIN_AVG_PCT) {
    dominant = "neutral";
    dominantAvg = averagesFloat.neutral;
  }
  const dominantPct = clampPct(dominantAvg);

  // ── Stress / positivity proxies
  const stressScore = clampPct(
    (averagesFloat.fear + averagesFloat.sad + averagesFloat.angry) / 3,
  );
  const positivityScore = clampPct(
    (averagesFloat.happy + averagesFloat.surprise) / 2,
  );

  // ── 15s-bucketed timeline (shape matches EmotionOverTimeChart)
  const lastTs = valid[valid.length - 1].timestamp;
  const usableDuration =
    duration && duration > 0 ? duration : lastTs + BUCKET_SIZE_SEC;
  const coverageSec = Math.min(usableDuration, Math.round(lastTs));
  const timeline = [];
  for (let start = 0; start < usableDuration; start += BUCKET_SIZE_SEC) {
    const end = Math.min(start + BUCKET_SIZE_SEC, usableDuration);
    const inBucket = valid.filter(
      (s) => s.timestamp >= start && s.timestamp < end,
    );
    const entry = {
      bucketStart: Math.round(start * 100) / 100,
      bucketEnd: Math.round(end * 100) / 100,
    };
    for (const k of EMOTION_KEYS) {
      if (inBucket.length) {
        const avg =
          inBucket.reduce((acc, s) => acc + safe(s.probs[k]), 0) /
          inBucket.length;
        entry[k] = Math.round(avg * 100);
      } else {
        entry[k] = 0;
      }
    }
    timeline.push(entry);
  }

  // ── Engagement arc (first third vs last third positivity)
  let engagementArc = "stable";
  if (valid.length >= 6) {
    const third = Math.max(1, Math.floor(valid.length / 3));
    const series = valid.map(
      (s) => (safe(s.probs.happy) + safe(s.probs.surprise)) * 100,
    );
    const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const firstEng = avg(series.slice(0, third));
    const lastEng = avg(series.slice(-third));
    const diff = lastEng - firstEng;
    const variance = (() => {
      const m = avg(series);
      return avg(series.map((v) => (v - m) ** 2));
    })();
    if (variance > 20) engagementArc = "variable";
    else if (diff > 10) engagementArc = "rising";
    else if (diff < -10) engagementArc = "falling";
  }

  // ── Peak moments (2s sustained windows, top 3, spaced by 8s)
  const PEAK_WINDOW = 2.0;
  const buckets = new Map();
  for (const s of valid) {
    const k = Math.floor(s.timestamp / PEAK_WINDOW) * PEAK_WINDOW;
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(s.probs);
  }
  const candidates = [];
  for (const [bucketStart, list] of buckets.entries()) {
    if (list.length < 2) continue;
    const bucketAvg = Object.fromEntries(
      EMOTION_KEYS.map((k) => [
        k,
        list.reduce((acc, p) => acc + safe(p[k]), 0) / list.length,
      ]),
    );
    let top = null;
    let topVal = 0;
    for (const k of EMOTION_KEYS) {
      if (k === "neutral") continue;
      if (bucketAvg[k] > topVal) {
        topVal = bucketAvg[k];
        top = k;
      }
    }
    if (!top || topVal < PEAK_MIN_INTENSITY) continue;
    candidates.push({
      timestamp: Math.round(bucketStart * 100) / 100,
      emotion: top,
      intensity: Math.round(topVal * 1000) / 1000,
    });
  }
  candidates.sort((a, b) => b.intensity - a.intensity);
  const peaks = [];
  for (const c of candidates) {
    if (
      peaks.every(
        (p) => Math.abs(p.timestamp - c.timestamp) >= PEAK_MIN_SPACING_SEC,
      )
    ) {
      peaks.push({ ...c, label: PEAK_LABELS[c.emotion] || "Emotion Peak" });
    }
    if (peaks.length >= 3) break;
  }
  peaks.sort((a, b) => a.timestamp - b.timestamp);

  return {
    averages,
    timeline,
    peaks,
    sampleCount: total,
    coverageSec,
    dominant,
    dominantPct,
    stressScore,
    positivityScore,
    engagementArc,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────
const ARC_META = {
  rising: { icon: "📈", label: "Rising", tone: "positive" },
  falling: { icon: "📉", label: "Falling", tone: "warning" },
  stable: { icon: "➡️", label: "Stable", tone: "neutral" },
  variable: { icon: "〰️", label: "Variable", tone: "neutral" },
};

function MetricGauge({ value, color, label }) {
  const stroke = 6;
  const size = 56;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const safeVal = Math.max(0, Math.min(100, value || 0));
  const dashOffset = circumference * (1 - safeVal / 100);
  return (
    <div className="les-gauge" title={label}>
      <svg width={size} height={size}>
        <circle
          className="les-gauge__bg"
          cx={size / 2}
          cy={size / 2}
          r={radius}
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          strokeWidth={stroke}
          fill="none"
          stroke={color}
          strokeLinecap="round"
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          style={{
            strokeDasharray: circumference,
            strokeDashoffset: dashOffset,
            transition: "stroke-dashoffset 0.6s ease",
          }}
        />
      </svg>
      <div className="les-gauge__value">
        <span className="les-gauge__num">{safeVal}</span>
        <span className="les-gauge__unit">/100</span>
      </div>
    </div>
  );
}

function HeroCard({ tone, icon, label, children, accentColor }) {
  return (
    <div
      className={`les-hero-card les-hero-card--${tone}`}
      style={accentColor ? { "--accent": accentColor } : undefined}
    >
      <div className="les-hero-card__label">
        <span className="les-hero-card__icon">{icon}</span>
        {label}
      </div>
      <div className="les-hero-card__body">{children}</div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main export
// ─────────────────────────────────────────────────────────────────────────────
export default function LocalEmotionSummary({ samples, videoEl, duration }) {
  const summary = useMemo(
    () => buildSummary(samples, duration),
    [samples, duration],
  );

  const {
    averages,
    timeline,
    peaks,
    sampleCount,
    coverageSec,
    dominant,
    dominantPct,
    stressScore,
    positivityScore,
    engagementArc,
  } = summary;

  const handleSeek = (ts) => {
    if (!videoEl) return;
    try {
      videoEl.currentTime = Number(ts) || 0;
      const p = videoEl.play?.();
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch (_err) {
      /* ignore */
    }
  };

  const stressColor =
    stressScore > 55 ? "#ef4444" : stressScore > 30 ? "#f59e0b" : "#22c55e";
  const positivityColor =
    positivityScore > 40 ? "#15803d" : positivityScore > 20 ? "#22c55e" : "#86efac";
  const dominantColor = EMOTION_COLORS[dominant] || EMOTION_COLORS.neutral;
  const arc = ARC_META[engagementArc] || ARC_META.stable;

  const overallStatus =
    stressScore > 55
      ? { tone: "warning", label: "Elevated stress signals" }
      : positivityScore > 25 && stressScore < 25
        ? { tone: "positive", label: "Calm & engaged" }
        : { tone: "neutral", label: "Mixed signals" };

  return (
    <section className="les-section" aria-label="Emotion summary">
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <header className="les-header">
        <div className="les-header__lead">
          <span className="les-header__emoji">🎭</span>
          <div>
            <h3 className="les-header__title">Emotion Summary</h3>
            <p className="les-header__subtitle">
              Computed locally from the recording as you play — advisory only,
              never affects scoring.
            </p>
          </div>
        </div>
        <div className="les-header__meta">
          <span className={`les-pill les-pill--${overallStatus.tone}`}>
            {overallStatus.label}
          </span>
          <span className="les-pill les-pill--info">
            {sampleCount} sample{sampleCount === 1 ? "" : "s"}
            {coverageSec > 0 && <> · {formatTime(coverageSec)} covered</>}
          </span>
        </div>
      </header>

      {sampleCount === 0 ? (
        <div className="les-empty">
          <span className="les-empty__icon">▶</span>
          <div>
            <strong>No samples yet.</strong>
            <p>Press play on the recording above — emotion signals will appear here in real time.</p>
          </div>
        </div>
      ) : (
        <>
          {/* ── Hero metrics row ───────────────────────────────────────── */}
          <div className="les-hero">
            <HeroCard
              tone="dominant"
              icon="✨"
              label="Dominant Emotion"
              accentColor={dominantColor}
            >
              <div className="les-dominant">
                <span className="les-dominant__emoji">
                  {EMOTION_EMOJI[dominant]}
                </span>
                <div className="les-dominant__text">
                  <span
                    className="les-dominant__name"
                    style={{ color: dominantColor }}
                  >
                    {capitalize(dominant)}
                  </span>
                  <span className="les-dominant__sub">
                    {dominantPct}% of session
                  </span>
                </div>
              </div>
            </HeroCard>

            <HeroCard
              tone={stressScore > 55 ? "warning" : stressScore > 30 ? "caution" : "calm"}
              icon="🌊"
              label="Stress Indicator"
              accentColor={stressColor}
            >
              <div className="les-gauge-wrap">
                <MetricGauge
                  value={stressScore}
                  color={stressColor}
                  label="Stress score"
                />
                <span className="les-gauge-label" style={{ color: stressColor }}>
                  {stressScore > 55 ? "High" : stressScore > 30 ? "Moderate" : "Low"}
                </span>
              </div>
            </HeroCard>

            <HeroCard
              tone={positivityScore > 25 ? "positive" : "neutral"}
              icon="🌟"
              label="Positivity Indicator"
              accentColor={positivityColor}
            >
              <div className="les-gauge-wrap">
                <MetricGauge
                  value={positivityScore}
                  color={positivityColor}
                  label="Positivity score"
                />
                <span className="les-gauge-label" style={{ color: positivityColor }}>
                  {positivityScore > 40 ? "High" : positivityScore > 20 ? "Steady" : "Low"}
                </span>
              </div>
            </HeroCard>

            <HeroCard tone={arc.tone} icon="🎯" label="Engagement Arc">
              <div className="les-arc">
                <span className="les-arc__icon">{arc.icon}</span>
                <div className="les-arc__text">
                  <span className="les-arc__label">{arc.label}</span>
                  <span className="les-arc__sub">over recording</span>
                </div>
              </div>
            </HeroCard>
          </div>

          {/* ── Sub-sections (reused components) ───────────────────────── */}
          <div className="les-card">
            <EmotionBreakdown averages={averages} animate />
          </div>

          <div className="les-card">
            <EmotionOverTimeChart timeline={timeline} onSeek={handleSeek} />
          </div>

          <div className="les-card les-card--peaks">
            <PeakMoments moments={peaks} onSeek={handleSeek} />
          </div>

          <footer className="les-footer">
            <span className="les-footer__icon">ℹ️</span>
            <span>
              Advisory only. These signals reflect facial-expression patterns
              read from the recording and must not be used as the sole basis for
              hiring decisions.
            </span>
          </footer>
        </>
      )}
    </section>
  );
}
