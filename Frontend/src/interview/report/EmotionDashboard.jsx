/**
 * EmotionDashboard
 *
 * Recruiter-only emotion overview panel that aggregates DeepFace per-frame
 * probabilities (already computed server-side as `emotionSummary`) into
 * stat cards, an emotion-breakdown bar list, a stacked area chart of
 * emotion-over-time, and a clickable "peak moments" list. Advisory only —
 * never affects scoring or hiring decisions.
 */
import { useEffect, useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import "./EmotionDashboard.css";

export const EMOTION_KEYS = [
  "neutral",
  "happy",
  "sad",
  "fear",
  "angry",
  "surprise",
  "disgust",
];

export const EMOTION_EMOJI = {
  neutral: "😐",
  happy: "😊",
  sad: "😢",
  fear: "😨",
  angry: "😠",
  surprise: "😲",
  disgust: "🤢",
};

export const EMOTION_COLORS = {
  neutral: "#94a3b8",
  happy: "#22c55e",
  sad: "#3b82f6",
  fear: "#f59e0b",
  angry: "#ef4444",
  surprise: "#84cc16",
  disgust: "#a16207",
};

const STRESS_COLORS = {
  low: "#22c55e",
  medium: "#f59e0b",
  high: "#ef4444",
};

const POSITIVITY_COLORS = {
  low: "#86efac",
  medium: "#22c55e",
  high: "#15803d",
};

const ARC_META = {
  rising: { icon: "📈", label: "Rising", tone: "positive" },
  falling: { icon: "📉", label: "Falling", tone: "negative" },
  stable: { icon: "➡️", label: "Stable", tone: "neutral" },
  variable: { icon: "〰️", label: "Variable", tone: "warning" },
};

const PEAK_ICON = {
  fear: "⚡",
  sad: "⚡",
  angry: "⚡",
  happy: "⭐",
  surprise: "⭐",
  disgust: "🌀",
  neutral: "📍",
};

const PEAK_TONE = {
  fear: "warning",
  sad: "warning",
  angry: "warning",
  happy: "positive",
  surprise: "positive",
  disgust: "neutral",
  neutral: "neutral",
};

const STATUS_META = {
  green: {
    icon: "🟢",
    label: "Calm & Engaged",
    description:
      "Candidate showed steady composure with positive engagement signals.",
    className: "ed-status--green",
  },
  yellow: {
    icon: "🟡",
    label: "Mixed Signals",
    description:
      "Behavior shifted across the interview — review peak moments for context.",
    className: "ed-status--yellow",
  },
  red: {
    icon: "🔴",
    label: "Elevated Stress",
    description:
      "Stress-leaning signals were sustained — consider a follow-up conversation.",
    className: "ed-status--red",
  },
};

function classifyOverall({ stressScore, positivityScore }) {
  const s = Number(stressScore) || 0;
  const p = Number(positivityScore) || 0;
  if (s > 55) return "red";
  if (s < 25 && p > 15) return "green";
  return "yellow";
}

// Defensive cleanup for older cached emotion payloads: if the reported
// dominant emotion has near-zero average probability (a Python `max()`
// tie-break artefact when every probability rounds to 0), override it to
// "neutral" so the dashboard doesn't claim "Angry 100% of frames" while
// every breakdown bar reads 0%.
const DOMINANT_MIN_AVG = 2;
function normalizeEmotionSummary(summary) {
  if (!summary) return summary;
  const averages = summary.emotionAverages || {};
  const peakKey = Object.keys(averages).reduce(
    (acc, k) =>
      Number(averages[k]) > Number(averages[acc] ?? -Infinity) ? k : acc,
    "neutral",
  );
  const peakAvg = Number(averages[peakKey] ?? 0);
  // Signal is too weak to attribute → force neutral and zero out the %.
  if (peakAvg < DOMINANT_MIN_AVG) {
    return {
      ...summary,
      dominantEmotion: "neutral",
      dominantEmotionPercent: 0,
    };
  }
  // Signal is real but the backend picked a different (tie-broken) key —
  // realign dominantEmotion with the actual peak in emotionAverages.
  if (
    summary.dominantEmotion &&
    summary.dominantEmotion !== peakKey &&
    Number(averages[summary.dominantEmotion] ?? 0) < peakAvg
  ) {
    return { ...summary, dominantEmotion: peakKey };
  }
  return summary;
}

function generateInsightSentence(summary) {
  const {
    stressLevel,
    positivityLevel,
    engagementArc,
    dominantEmotion,
    dominantEmotionPercent,
  } = summary;

  if (stressLevel === "high") {
    return "⚠️ Candidate showed elevated stress signals — consider a follow-up conversation.";
  }
  if (positivityLevel === "high" && engagementArc === "rising") {
    return "✅ Candidate appeared increasingly engaged and positive throughout the interview.";
  }
  if (positivityLevel === "high") {
    return "✅ Candidate showed sustained positive expression during the interview.";
  }
  if (engagementArc === "falling") {
    return "📉 Engagement declined toward the end — review later questions for context.";
  }
  if (engagementArc === "rising") {
    return "📈 Engagement increased as the interview progressed.";
  }
  if (engagementArc === "variable") {
    return "〰️ Engagement varied — review peak moments for the most notable shifts.";
  }
  if (Number(dominantEmotionPercent) > 75 && dominantEmotion === "neutral") {
    return "😐 Candidate maintained a consistently neutral composure throughout.";
  }
  return "📊 Mixed emotional signals — review peak moments for key timestamps.";
}

const STRESS_TOOLTIP =
  "Stress Score is a visual proxy based on facial expression signals. " +
  "It is advisory only and must not influence hiring decisions.";

export const formatTime = (s) => {
  if (!Number.isFinite(s)) return "0:00";
  const total = Math.max(0, Math.floor(s));
  const m = Math.floor(total / 60);
  const sec = total % 60;
  return `${m}:${sec.toString().padStart(2, "0")}`;
};

export const capitalize = (s) =>
  typeof s === "string" && s.length ? s[0].toUpperCase() + s.slice(1) : s;

function GaugeRing({ score, color, size = 72 }) {
  const stroke = 7;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const safe = Math.max(0, Math.min(100, Number(score) || 0));
  const dashOffset = circumference * (1 - safe / 100);

  return (
    <div className="ed-gauge" style={{ width: size, height: size }}>
      <svg width={size} height={size}>
        <circle
          className="ed-gauge__bg"
          cx={size / 2}
          cy={size / 2}
          r={radius}
          strokeWidth={stroke}
        />
        <circle
          className="ed-gauge__fill"
          cx={size / 2}
          cy={size / 2}
          r={radius}
          strokeWidth={stroke}
          style={{
            stroke: color,
            strokeDasharray: circumference,
            strokeDashoffset: dashOffset,
          }}
        />
      </svg>
      <div className="ed-gauge__center">
        <span className="ed-gauge__value">{safe}</span>
        <span className="ed-gauge__unit">/100</span>
      </div>
    </div>
  );
}

function StatCard({ tone = "neutral", label, children, hint }) {
  return (
    <div className={`ed-stat-card ed-stat-card--${tone}`} title={hint || undefined}>
      <div className="ed-stat-card__label">{label}</div>
      <div className="ed-stat-card__body">{children}</div>
    </div>
  );
}

function LevelChip({ level, color }) {
  return (
    <span className="ed-level-chip" style={{ color, borderColor: `${color}55`, background: `${color}1a` }}>
      {capitalize(level)}
    </span>
  );
}

export function EmotionBreakdown({ averages, animate }) {
  const sorted = useMemo(
    () =>
      EMOTION_KEYS.map((k) => ({ key: k, value: Number(averages?.[k] ?? 0) }))
        .sort((a, b) => b.value - a.value),
    [averages],
  );

  return (
    <div className="ed-card ed-breakdown">
      <div className="ed-card__head">
        <h4 className="ed-card__title">Emotion Breakdown</h4>
        <span className="ed-card__hint">Average distribution across the interview</span>
      </div>
      <div className="ed-bar-list">
        {sorted.map(({ key, value }) => (
          <div key={key} className="ed-bar-row">
            <div className="ed-bar-row__label">
              <span className="ed-bar-row__emoji">{EMOTION_EMOJI[key]}</span>
              <span className="ed-bar-row__name">{capitalize(key)}</span>
            </div>
            <div className="ed-bar-row__track">
              <div
                className="ed-bar-row__fill"
                style={{
                  width: animate ? `${value}%` : "0%",
                  background: `linear-gradient(90deg, ${EMOTION_COLORS[key]}99, ${EMOTION_COLORS[key]})`,
                }}
              />
            </div>
            <div className="ed-bar-row__pct">{value}%</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ChartLegend() {
  const items = [
    { label: "Neutral", color: EMOTION_COLORS.neutral },
    { label: "Happy", color: EMOTION_COLORS.happy },
    { label: "Surprise", color: EMOTION_COLORS.surprise },
    { label: "Stress", color: EMOTION_COLORS.angry, note: "fear + sad + angry" },
  ];
  return (
    <div className="ed-legend">
      {items.map((it) => (
        <div className="ed-legend__item" key={it.label}>
          <span className="ed-legend__dot" style={{ background: it.color }} />
          <span className="ed-legend__label">{it.label}</span>
          {it.note && <span className="ed-legend__note">({it.note})</span>}
        </div>
      ))}
    </div>
  );
}

export function EmotionOverTimeChart({ timeline, onSeek }) {
  const data = useMemo(
    () =>
      (timeline || []).map((b) => ({
        bucketStart: b.bucketStart,
        time: formatTime(b.bucketStart),
        Neutral: Number(b.neutral || 0),
        Happy: Number(b.happy || 0),
        Surprise: Number(b.surprise || 0),
        Stress:
          Number(b.fear || 0) +
          Number(b.sad || 0) +
          Number(b.angry || 0),
      })),
    [timeline],
  );

  if (!data.length) {
    return (
      <div className="ed-card ed-chart-card">
        <div className="ed-card__head">
          <div>
            <h4 className="ed-card__title">Emotion Over Time</h4>
          </div>
          <ChartLegend />
        </div>
        <div className="ed-empty">
          Not enough emotion samples to draw the timeline chart.
        </div>
      </div>
    );
  }

  const handleClick = (state) => {
    if (!state || !state.activePayload || !state.activePayload[0]) return;
    const payload = state.activePayload[0].payload;
    if (typeof payload?.bucketStart === "number") onSeek(payload.bucketStart);
  };

  return (
    <div className="ed-card ed-chart-card">
      <div className="ed-card__head">
        <div>
          <h4 className="ed-card__title">Emotion Over Time</h4>
          <span className="ed-card__hint">Click any point on the chart to jump to that moment</span>
        </div>
        <ChartLegend />
      </div>

      <div className="ed-chart-wrapper">
        <ResponsiveContainer width="100%" height={200}>
          <AreaChart
            data={data}
            margin={{ top: 8, right: 16, bottom: 0, left: -8 }}
            onClick={handleClick}
          >
            <defs>
              <linearGradient id="ed-grad-neutral" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={EMOTION_COLORS.neutral} stopOpacity={0.55} />
                <stop offset="100%" stopColor={EMOTION_COLORS.neutral} stopOpacity={0.08} />
              </linearGradient>
              <linearGradient id="ed-grad-happy" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={EMOTION_COLORS.happy} stopOpacity={0.65} />
                <stop offset="100%" stopColor={EMOTION_COLORS.happy} stopOpacity={0.08} />
              </linearGradient>
              <linearGradient id="ed-grad-stress" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={EMOTION_COLORS.angry} stopOpacity={0.65} />
                <stop offset="100%" stopColor={EMOTION_COLORS.angry} stopOpacity={0.08} />
              </linearGradient>
              <linearGradient id="ed-grad-surprise" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={EMOTION_COLORS.surprise} stopOpacity={0.6} />
                <stop offset="100%" stopColor={EMOTION_COLORS.surprise} stopOpacity={0.08} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(148, 163, 184, 0.12)" />
            <XAxis
              dataKey="time"
              tick={{ fill: "#94a3b8", fontSize: 11 }}
              stroke="rgba(148, 163, 184, 0.25)"
              tickLine={false}
            />
            <YAxis
              tick={{ fill: "#94a3b8", fontSize: 11 }}
              domain={[0, 100]}
              tickFormatter={(v) => `${v}%`}
              stroke="rgba(148, 163, 184, 0.25)"
              tickLine={false}
              axisLine={false}
            />
            <Tooltip
              contentStyle={{
                background: "rgba(15, 23, 42, 0.96)",
                border: "1px solid rgba(99, 102, 241, 0.35)",
                borderRadius: 10,
                color: "#e2e8f0",
                fontSize: 12,
                boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
              }}
              cursor={{ stroke: "#6366f1", strokeWidth: 1, strokeDasharray: "3 3" }}
              formatter={(value, name) => [`${value}%`, name]}
            />
            <Area
              type="monotone"
              dataKey="Neutral"
              stackId="1"
              stroke={EMOTION_COLORS.neutral}
              fill="url(#ed-grad-neutral)"
              strokeWidth={1.5}
            />
            <Area
              type="monotone"
              dataKey="Happy"
              stackId="1"
              stroke={EMOTION_COLORS.happy}
              fill="url(#ed-grad-happy)"
              strokeWidth={1.5}
            />
            <Area
              type="monotone"
              dataKey="Surprise"
              stackId="1"
              stroke={EMOTION_COLORS.surprise}
              fill="url(#ed-grad-surprise)"
              strokeWidth={1.5}
            />
            <Area
              type="monotone"
              dataKey="Stress"
              stackId="1"
              stroke={EMOTION_COLORS.angry}
              fill="url(#ed-grad-stress)"
              strokeWidth={1.5}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export function PeakMoments({ moments, onSeek }) {
  if (!moments?.length) {
    return (
      <div className="ed-card">
        <div className="ed-card__head">
          <h4 className="ed-card__title">Peak Moments</h4>
        </div>
        <div className="ed-empty">No significant emotional peaks were detected.</div>
      </div>
    );
  }
  return (
    <div className="ed-card ed-peaks">
      <div className="ed-card__head">
        <h4 className="ed-card__title">Peak Moments</h4>
        <span className="ed-card__hint">Top 3 most intense moments — click to jump in the recording</span>
      </div>
      <div className="ed-peak-list">
        {moments.map((m, idx) => {
          const intensityPct = Math.round((Number(m.intensity) || 0) * 100);
          const tone = PEAK_TONE[m.emotion] || "neutral";
          const color = EMOTION_COLORS[m.emotion] || EMOTION_COLORS.neutral;
          return (
            <div
              key={`${m.timestamp}-${m.emotion}-${idx}`}
              className={`ed-peak ed-peak--${tone}`}
              onClick={() => onSeek(m.timestamp)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") onSeek(m.timestamp);
              }}
            >
              <div className="ed-peak__icon" style={{ color }}>
                {PEAK_ICON[m.emotion] || "📍"}
              </div>
              <div className="ed-peak__meta">
                <div className="ed-peak__title">{m.label}</div>
                <div className="ed-peak__sub">
                  <span className="ed-peak__time">{formatTime(m.timestamp)}</span>
                  <span className="ed-peak__dot">•</span>
                  <span className="ed-peak__emotion" style={{ color }}>
                    {capitalize(m.emotion)}
                  </span>
                </div>
              </div>
              <div className="ed-peak__bar">
                <div
                  className="ed-peak__bar-fill"
                  style={{
                    width: `${intensityPct}%`,
                    background: `linear-gradient(90deg, ${color}aa, ${color})`,
                  }}
                />
              </div>
              <div className="ed-peak__intensity">{intensityPct}%</div>
              <button
                type="button"
                className="ed-peak__jump"
                onClick={(e) => {
                  e.stopPropagation();
                  onSeek(m.timestamp);
                }}
                aria-label={`Jump to ${formatTime(m.timestamp)}`}
              >
                Jump →
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function EmotionDashboard({
  emotionSummary,
  videoEl,
  isVisible,
}) {
  const [animateBars, setAnimateBars] = useState(false);

  useEffect(() => {
    if (!isVisible) {
      setAnimateBars(false);
      return undefined;
    }
    const t = setTimeout(() => setAnimateBars(true), 80);
    return () => clearTimeout(t);
  }, [isVisible]);

  if (!isVisible || !emotionSummary) return null;

  const safeSummary = normalizeEmotionSummary(emotionSummary);

  const {
    dominantEmotion = "neutral",
    dominantEmotionPercent = 0,
    emotionAverages = {},
    stressScore = 0,
    stressLevel = "low",
    positivityScore = 0,
    positivityLevel = "low",
    peakMoments = [],
    emotionTimeline = [],
    engagementArc = "stable",
  } = safeSummary;

  const overall = classifyOverall({ stressScore, positivityScore });
  const status = STATUS_META[overall];
  const insightSentence = generateInsightSentence(safeSummary);
  const arc = ARC_META[engagementArc] || ARC_META.stable;
  const stressColor = STRESS_COLORS[stressLevel] || STRESS_COLORS.low;
  const positivityColor =
    POSITIVITY_COLORS[positivityLevel] || POSITIVITY_COLORS.low;
  const dominantColor = EMOTION_COLORS[dominantEmotion] || EMOTION_COLORS.neutral;

  const seekTo = (ts) => {
    if (!videoEl) return;
    try {
      videoEl.currentTime = Number(ts) || 0;
      const p = videoEl.play();
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch (err) {
      console.error("[EmotionDashboard] seek failed:", err);
    }
  };

  return (
    <section className="ed-dashboard" aria-label="Candidate emotion overview">
      <header className="ed-header">
        <div className="ed-header__left">
          <div className="ed-header__icon">🎭</div>
          <div>
            <h3 className="ed-header__title">Candidate Emotion Overview</h3>
            <p className="ed-header__subtitle">
              Visual aid for recruiter review — does not influence scoring or hiring decisions.
            </p>
          </div>
        </div>
        <div className="ed-header__right">
          <span className="ed-advisory-badge" title={STRESS_TOOLTIP}>
            <span className="ed-advisory-dot" /> Advisory only
          </span>
        </div>
      </header>

      <div className={`ed-status-banner ${status.className}`}>
        <div className="ed-status-banner__pill">
          <span className="ed-status-banner__icon">{status.icon}</span>
          <span className="ed-status-banner__label">{status.label}</span>
        </div>
        <div className="ed-status-banner__text">
          <div className="ed-status-banner__primary">{insightSentence}</div>
          <div className="ed-status-banner__secondary">{status.description}</div>
        </div>
      </div>

      <div className="ed-stat-grid">
        <StatCard tone="neutral" label="Dominant Emotion">
          <div className="ed-dominant">
            <div className="ed-dominant__emoji">
              {EMOTION_EMOJI[dominantEmotion] || "😐"}
            </div>
            <div className="ed-dominant__text">
              <div className="ed-dominant__name" style={{ color: dominantColor }}>
                {capitalize(dominantEmotion)}
              </div>
              <div className="ed-dominant__pct">
                {dominantEmotionPercent}% of frames
              </div>
            </div>
          </div>
        </StatCard>

        <StatCard tone={stressLevel} label="Stress Level" hint={STRESS_TOOLTIP}>
          <div className="ed-gauge-card">
            <GaugeRing score={stressScore} color={stressColor} />
            <LevelChip level={stressLevel} color={stressColor} />
          </div>
        </StatCard>

        <StatCard tone={positivityLevel === "high" ? "positive" : positivityLevel} label="Positivity Level">
          <div className="ed-gauge-card">
            <GaugeRing score={positivityScore} color={positivityColor} />
            <LevelChip level={positivityLevel} color={positivityColor} />
          </div>
        </StatCard>

        <StatCard tone={arc.tone} label="Engagement Arc">
          <div className="ed-arc">
            <div className="ed-arc__icon">{arc.icon}</div>
            <div className="ed-arc__label">{arc.label}</div>
            <div className="ed-arc__sub">over interview duration</div>
          </div>
        </StatCard>
      </div>

      <EmotionBreakdown averages={emotionAverages} animate={animateBars} />

      <EmotionOverTimeChart timeline={emotionTimeline} onSeek={seekTo} />

      <PeakMoments moments={peakMoments} onSeek={seekTo} />

      <footer className="ed-footer">
        <span className="ed-footer__icon">ℹ️</span>
        <span>
          Emotion signals are <strong>advisory</strong> and reflect facial-expression
          patterns only. They must not be used as a basis for hiring decisions.
        </span>
      </footer>
    </section>
  );
}
