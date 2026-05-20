/**
 * BehavioralTimelinePanel
 *
 * Recruiter-only advisory overlay on top of recorded interview playback.
 * Adds DeepFace face bounding boxes + safe-label badge to the existing
 * <video> element via a portal, and renders a clickable timeline + 10-second
 * heatmap below. Fully isolated from scoring, reports, and the existing
 * behavioral-insights overlay — controlled by its own toggle, disabled by
 * default, and lazy-loaded.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactDOM from "react-dom";

import { useBehavioralTimeline } from "./useBehavioralTimeline";
import "./BehavioralTimelinePanel.css";

const LABEL_COLORS = {
  "Neutral Behavioral Signal": "#9e9e9e",
  "Possible Hesitation": "#ff9800",
  "Positive Expression Shift": "#4caf50",
  "Behavioral Fluctuation": "#f44336",
  "Reduced Expressiveness": "#607d8b",
  "Increased Interaction Energy": "#8bc34a",
  "Silence + Behavioral Pause": "#795548",
  "Attention Variation": "#2196f3",
  "Engagement Variation": "#9c27b0",
};

const colorFor = (label) => LABEL_COLORS[label] || "#9e9e9e";

// Emotion → emoji + accent color for the on-video distribution panel.
const EMOTION_META = {
  happy:    { emoji: "😊", color: "#4ade80", label: "Happy" },
  neutral:  { emoji: "😐", color: "#94a3b8", label: "Neutral" },
  sad:      { emoji: "😢", color: "#60a5fa", label: "Sad" },
  angry:    { emoji: "😠", color: "#f87171", label: "Angry" },
  fear:     { emoji: "😨", color: "#fbbf24", label: "Fear" },
  surprise: { emoji: "😲", color: "#a3e635", label: "Surprise" },
  disgust:  { emoji: "🤢", color: "#a16207", label: "Disgust" },
};

const formatTime = (s) => {
  if (!Number.isFinite(s)) return "0:00";
  const total = Math.max(0, Math.floor(s));
  const m = Math.floor(total / 60);
  const sec = total % 60;
  return `${m}:${sec.toString().padStart(2, "0")}`;
};

// ── 68-point face landmark groups (dlib / iBUG standard) ───────────────────
// Each entry: [startIdx, endIdx (inclusive), closedPath]
const FACE_FEATURES = [
  { range: [0, 16], closed: false }, // jawline
  { range: [17, 21], closed: false }, // right brow
  { range: [22, 26], closed: false }, // left brow
  { range: [27, 30], closed: false }, // nose ridge
  { range: [31, 35], closed: false }, // nose base
  { range: [36, 41], closed: true }, // right eye
  { range: [42, 47], closed: true }, // left eye
  { range: [48, 59], closed: true }, // outer lip
  { range: [60, 67], closed: true }, // inner lip
];

// Find the two landmark frames that bracket the given video time.
// Returns { prev, next, alpha } where alpha is the 0..1 lerp position.
function bracketLandmarkFrames(frameLandmarks, t) {
  if (!Array.isArray(frameLandmarks) || frameLandmarks.length === 0) return null;
  if (t <= frameLandmarks[0].t) return { prev: frameLandmarks[0], next: frameLandmarks[0], alpha: 0 };
  const last = frameLandmarks[frameLandmarks.length - 1];
  if (t >= last.t) return { prev: last, next: last, alpha: 0 };
  // Binary search
  let lo = 0;
  let hi = frameLandmarks.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (frameLandmarks[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const prev = frameLandmarks[lo];
  const next = frameLandmarks[hi];
  const span = next.t - prev.t;
  const alpha = span > 0 ? (t - prev.t) / span : 0;
  return { prev, next, alpha };
}

// Linearly interpolate the 136-element flat points array between two frames.
function interpolatePts(prevPts, nextPts, alpha) {
  if (!prevPts || prevPts.length === 0) return nextPts || [];
  if (!nextPts || nextPts.length === 0) return prevPts;
  if (prevPts.length !== nextPts.length) return prevPts;
  const out = new Array(prevPts.length);
  for (let i = 0; i < prevPts.length; i++) {
    out[i] = prevPts[i] + (nextPts[i] - prevPts[i]) * alpha;
  }
  return out;
}

// Synthetic decorative wireframe — used when real landmarks aren't
// available yet (older cached docs, extraction failure). Draws an
// approximate face mesh derived purely from the face_box geometry.
function drawSyntheticMesh(ctx, c, faceBox, frameW, frameH) {
  if (!faceBox) return;
  const fw = frameW || c.width;
  const fh = frameH || c.height;
  const sx = c.width / fw;
  const sy = c.height / fh;
  const { x, y, w, h } = faceBox;

  // DeepFace boxes include scalp/chin/ear padding — shrink to fit the face
  const SHRINK = 0.72;
  const faceCx = x + w / 2;
  const faceCy = y + h / 2;
  const sw = w * SHRINK;
  const sh = h * SHRINK;

  const px = (faceCx - sw / 2) * sx;
  const py = (faceCy - sh / 2) * sy;
  const pw = sw * sx;
  const ph = sh * sy;

  const LASER = "#22d3ee";
  const LASER_GLOW = "#67e8f9";

  ctx.save();
  ctx.shadowColor = LASER_GLOW;
  ctx.shadowBlur = Math.max(6, c.width / 240);
  ctx.lineWidth = Math.max(1.5, c.width / 480);
  ctx.strokeStyle = LASER;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  // Outer face rectangle
  ctx.strokeRect(px, py, pw, ph);

  // L-shaped corner brackets
  const bracketLen = Math.max(8, Math.min(pw, ph) * 0.18);
  ctx.lineWidth = Math.max(2, c.width / 320);
  ctx.beginPath();
  ctx.moveTo(px, py + bracketLen); ctx.lineTo(px, py); ctx.lineTo(px + bracketLen, py);
  ctx.moveTo(px + pw - bracketLen, py); ctx.lineTo(px + pw, py); ctx.lineTo(px + pw, py + bracketLen);
  ctx.moveTo(px, py + ph - bracketLen); ctx.lineTo(px, py + ph); ctx.lineTo(px + bracketLen, py + ph);
  ctx.moveTo(px + pw - bracketLen, py + ph); ctx.lineTo(px + pw, py + ph); ctx.lineTo(px + pw, py + ph - bracketLen);
  ctx.stroke();

  // Eye line + pupils
  const cx = px + pw / 2;
  const eyeY = py + ph * 0.38;
  const eyeLX = px + pw * 0.30;
  const eyeRX = px + pw * 0.70;
  ctx.lineWidth = Math.max(1, c.width / 700);
  ctx.beginPath();
  ctx.moveTo(eyeLX, eyeY); ctx.lineTo(eyeRX, eyeY);
  ctx.stroke();
  ctx.fillStyle = LASER;
  ctx.beginPath();
  ctx.arc(eyeLX, eyeY, Math.max(2, pw * 0.018), 0, Math.PI * 2);
  ctx.arc(eyeRX, eyeY, Math.max(2, pw * 0.018), 0, Math.PI * 2);
  ctx.fill();

  // Nose ridge + mouth line
  ctx.beginPath();
  ctx.moveTo(cx, eyeY + ph * 0.05); ctx.lineTo(cx, py + ph * 0.68);
  ctx.moveTo(cx - pw * 0.16, py + ph * 0.80); ctx.lineTo(cx + pw * 0.16, py + ph * 0.80);
  ctx.stroke();

  ctx.restore();
}

// ── Canvas overlay drawn into the existing <video> parent ───────────────────
function CanvasOverlay({ videoEl, frameLandmarks, activeEvent }) {
  const canvasRef = useRef(null);
  const rafRef = useRef(null);

  // Keep canvas sized to the actual rendered video element.
  useEffect(() => {
    if (!videoEl || !canvasRef.current) return undefined;
    const sync = () => {
      const c = canvasRef.current;
      if (!c) return;
      const rect = videoEl.getBoundingClientRect();
      c.width = videoEl.videoWidth || Math.round(rect.width) || 640;
      c.height = videoEl.videoHeight || Math.round(rect.height) || 360;
    };
    sync();
    videoEl.addEventListener("loadedmetadata", sync);
    const ro = new ResizeObserver(sync);
    ro.observe(videoEl);
    return () => {
      videoEl.removeEventListener("loadedmetadata", sync);
      ro.disconnect();
    };
  }, [videoEl]);

  // Draw loop at the rAF rate (~60fps) so the mesh tracks the video smoothly.
  // We read videoEl.currentTime each tick, find the bracketing landmark
  // frames, lerp between them, and render the mesh at the interpolated
  // positions. No throttle here — the interpolation does the smoothing.
  useEffect(() => {
    if (!videoEl || !canvasRef.current) return undefined;
    const ctx = canvasRef.current.getContext("2d");

    const draw = () => {
      rafRef.current = requestAnimationFrame(draw);
      const c = canvasRef.current;
      if (!c || !ctx || !videoEl) return;
      ctx.clearRect(0, 0, c.width, c.height);

      const t = Number(videoEl.currentTime) || 0;
      const bracket = bracketLandmarkFrames(frameLandmarks || [], t);
      const pts = bracket
        ? interpolatePts(bracket.prev.pts, bracket.next.pts, bracket.alpha)
        : null;

      // Fallback path: no real landmarks available yet — draw the
      // synthetic wireframe derived from the active event's face_box so
      // the recruiter still sees a face mesh on the video.
      if (!pts || pts.length < 136) {
        if (activeEvent?.face_box) {
          drawSyntheticMesh(
            ctx,
            c,
            activeEvent.face_box,
            activeEvent.frame_width,
            activeEvent.frame_height,
          );
        }
        return;
      }
      const prev = bracket.prev;

      // The landmark coordinates are in the original frame space (prev.w × prev.h).
      // Map them to canvas coordinates.
      const fw = prev.w || videoEl.videoWidth || c.width;
      const fh = prev.h || videoEl.videoHeight || c.height;
      const sx = c.width / fw;
      const sy = c.height / fh;

      // Py-Feat bounding boxes include some padding around the face so the
      // raw landmarks sit slightly outside the visible face boundary. Pull
      // every point inward toward the face centroid by this factor so the
      // jaw arc and overall mesh fit tighter on screen.
      const MESH_SCALE = 0.84;
      let cxAcc = 0;
      let cyAcc = 0;
      for (let i = 0; i < 68; i++) {
        cxAcc += pts[i * 2] * sx;
        cyAcc += pts[i * 2 + 1] * sy;
      }
      const faceCx = cxAcc / 68;
      const faceCy = cyAcc / 68;
      const lx = (i) => faceCx + (pts[i * 2] * sx - faceCx) * MESH_SCALE;
      const ly = (i) => faceCy + (pts[i * 2 + 1] * sy - faceCy) * MESH_SCALE;

      const LASER = "#22d3ee"; // cyan
      const LASER_GLOW = "#67e8f9";

      ctx.save();
      ctx.shadowColor = LASER_GLOW;
      ctx.shadowBlur = Math.max(4, c.width / 300);
      ctx.strokeStyle = LASER;
      ctx.lineWidth = Math.max(1, c.width / 600);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";

      // 1) Draw each facial feature as a polyline (closed for eyes/lips).
      for (const feat of FACE_FEATURES) {
        const [a, b] = feat.range;
        ctx.beginPath();
        for (let i = a; i <= b; i++) {
          if (i === a) ctx.moveTo(lx(i), ly(i));
          else ctx.lineTo(lx(i), ly(i));
        }
        if (feat.closed) ctx.closePath();
        ctx.stroke();
      }

      // 2) Glowing dot at each landmark point.
      const dotR = Math.max(1.2, c.width / 900);
      ctx.fillStyle = LASER;
      for (let i = 0; i < 68; i++) {
        ctx.beginPath();
        ctx.arc(lx(i), ly(i), dotR, 0, Math.PI * 2);
        ctx.fill();
      }

      // 3) Pupil markers — slightly larger filled dots at the eye centers
      //    (mean of the 6 points per eye). Adds a "tracking" feel.
      const eyeCenter = (start) => {
        let ex = 0;
        let ey = 0;
        for (let i = start; i < start + 6; i++) {
          ex += lx(i);
          ey += ly(i);
        }
        return [ex / 6, ey / 6];
      };
      const [rex, rey] = eyeCenter(36);
      const [lex, ley] = eyeCenter(42);
      const pupilR = Math.max(1.8, c.width / 480);
      ctx.beginPath();
      ctx.arc(rex, rey, pupilR, 0, Math.PI * 2);
      ctx.arc(lex, ley, pupilR, 0, Math.PI * 2);
      ctx.fill();

      ctx.restore();
    };

    rafRef.current = requestAnimationFrame(draw);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [videoEl, frameLandmarks, activeEvent]);

  return <canvas ref={canvasRef} className="btp-canvas" />;
}

// ── HTML emotion distribution panel anchored next to the face box ──────────
function FaceEmotionPanel({ videoEl, activeEvent }) {
  const [box, setBox] = useState(null);

  // Recompute the panel's pixel position whenever the active face or the
  // video element resizes. We compute against the rendered video size
  // (not videoWidth/videoHeight) so percentages line up with what the
  // recruiter actually sees.
  useEffect(() => {
    if (!videoEl || !activeEvent?.face_box) {
      setBox(null);
      return undefined;
    }
    const compute = () => {
      const rect = videoEl.getBoundingClientRect();
      const parentRect = videoEl.parentElement?.getBoundingClientRect();
      if (!rect || !parentRect) return;
      const fw = activeEvent.frame_width || rect.width;
      const fh = activeEvent.frame_height || rect.height;
      const sx = rect.width / fw;
      const sy = rect.height / fh;
      const { x, y, w, h } = activeEvent.face_box;
      // px coords relative to parent (so absolutely-positioned panel works)
      const offsetX = rect.left - parentRect.left;
      const offsetY = rect.top - parentRect.top;
      setBox({
        left: offsetX + (x + w) * sx + 12,
        top: offsetY + y * sy,
        height: h * sy,
        rightEdge: parentRect.width,
      });
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(videoEl);
    window.addEventListener("scroll", compute, true);
    window.addEventListener("resize", compute);
    return () => {
      ro.disconnect();
      window.removeEventListener("scroll", compute, true);
      window.removeEventListener("resize", compute);
    };
  }, [videoEl, activeEvent]);

  if (!activeEvent?.raw_scores || !box) return null;

  // Sort the 7 emotions by probability descending.
  const sorted = Object.entries(activeEvent.raw_scores)
    .map(([k, v]) => ({ key: k, value: Number(v) || 0 }))
    .sort((a, b) => b.value - a.value);

  // If the panel would overflow the right edge, flip to the left side.
  const PANEL_WIDTH_EST = 200;
  const flipsLeft = box.left + PANEL_WIDTH_EST > box.rightEdge - 12;
  const style = flipsLeft
    ? {
        right: Math.max(12, box.rightEdge - box.left + PANEL_WIDTH_EST + 24),
        top: box.top,
        left: "auto",
      }
    : { left: box.left, top: box.top };

  return (
    <div className="btp-face-panel" style={style}>
      {sorted.map(({ key, value }) => {
        const meta = EMOTION_META[key];
        if (!meta) return null;
        const pct = Math.round(value * 100);
        return (
          <div key={key} className="btp-face-panel__row">
            <span className="btp-face-panel__emoji">{meta.emoji}</span>
            <span className="btp-face-panel__label" style={{ color: meta.color }}>
              {meta.label}
            </span>
            <span className="btp-face-panel__pct">{pct}%</span>
          </div>
        );
      })}
    </div>
  );
}

// ── Floating badge ──────────────────────────────────────────────────────────
function BehavioralBadge({ activeEvent }) {
  const [visible, setVisible] = useState(false);
  const prevIdRef = useRef(null);
  useEffect(() => {
    if (!activeEvent) {
      setVisible(false);
      prevIdRef.current = null;
      return;
    }
    const key = `${activeEvent.timestamp}-${activeEvent.label}`;
    if (prevIdRef.current !== key) {
      prevIdRef.current = key;
      setVisible(true);
    }
  }, [activeEvent]);

  if (!activeEvent) return null;
  const color = colorFor(activeEvent.label);
  return (
    <div
      className={`btp-badge ${visible ? "btp-badge--in" : "btp-badge--out"}`}
      style={{ borderLeftColor: color }}
    >
      <span className="btp-badge__label">{activeEvent.label}</span>
      <span className="btp-badge__confidence">
        {Math.round((activeEvent.confidence || 0) * 100)}%
      </span>
    </div>
  );
}

// ── Timeline markers + heatmap below the video ─────────────────────────────
function SafeLabelTimeline({ events, duration, currentTime, onSeek }) {
  if (!duration || duration <= 0) return null;
  return (
    <div className="btp-timeline">
      {events.map((ev, i) => {
        const left = (ev.timestamp / duration) * 100;
        const width = Math.max(
          0.5,
          (ev.duration / duration) * 100,
        );
        const active =
          currentTime >= ev.timestamp &&
          currentTime <= ev.timestamp + ev.duration;
        const tooltip = `${ev.label} @ ${formatTime(ev.timestamp)} · ${Math.round(
          (ev.confidence || 0) * 100,
        )}%${ev.explanation ? ` · ${ev.explanation}` : ""}`;
        return (
          <button
            key={`${ev.timestamp}-${i}`}
            type="button"
            className={`btp-timeline__marker ${active ? "btp-timeline__marker--active" : ""}`}
            style={{
              left: `${left}%`,
              width: `${width}%`,
              backgroundColor: colorFor(ev.label),
            }}
            title={tooltip}
            aria-label={tooltip}
            onClick={() => onSeek(ev.timestamp)}
          />
        );
      })}
    </div>
  );
}

function HeatmapStrip({ data, duration }) {
  if (!data || !data.length || !duration) return null;
  return (
    <div className="btp-heatmap">
      {data.map((bin, i) => (
        <div
          key={i}
          className={`btp-heatmap__bin btp-heatmap__bin--${bin.level}`}
          style={{
            width: `${((bin.end - bin.start) / duration) * 100}%`,
          }}
          title={`${formatTime(bin.start)}–${formatTime(bin.end)} · ${Math.round(
            (bin.intensity || 0) * 100,
          )}%`}
        />
      ))}
    </div>
  );
}

// ── Main panel ──────────────────────────────────────────────────────────────
export default function BehavioralTimelinePanel({ roomId, videoEl, onStateChange }) {
  const [showTimeline, setShowTimeline] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [videoDuration, setVideoDuration] = useState(0);

  const { data, status } = useBehavioralTimeline({
    interviewId: roomId,
    enabled: showTimeline,
  });

  // Bubble (showTimeline, data) up so sibling panels (e.g. EmotionDashboard)
  // can render against the same fetched data without triggering a second
  // analysis or duplicate request.
  useEffect(() => {
    if (typeof onStateChange === "function") {
      onStateChange({ showTimeline, data });
    }
  }, [onStateChange, showTimeline, data]);

  // Track playback time + duration from the shared <video> element.
  useEffect(() => {
    if (!videoEl) return undefined;
    const onTime = () => setCurrentTime(videoEl.currentTime || 0);
    const onMeta = () => setVideoDuration(videoEl.duration || 0);
    onMeta();
    videoEl.addEventListener("timeupdate", onTime);
    videoEl.addEventListener("loadedmetadata", onMeta);
    videoEl.addEventListener("durationchange", onMeta);
    return () => {
      videoEl.removeEventListener("timeupdate", onTime);
      videoEl.removeEventListener("loadedmetadata", onMeta);
      videoEl.removeEventListener("durationchange", onMeta);
    };
  }, [videoEl]);

  const events = data?.events || [];
  const heatmap = data?.heatmap || [];
  const summary = data?.summary || {};
  const duration =
    videoDuration || Number(summary.videoDuration) || 0;

  const activeEvent = useMemo(() => {
    if (!events.length) return null;
    return (
      events.find(
        (e) =>
          currentTime >= e.timestamp &&
          currentTime <= e.timestamp + e.duration,
      ) || null
    );
  }, [events, currentTime]);

  const handleSeek = useCallback(
    (ts) => {
      if (!videoEl) return;
      try {
        videoEl.currentTime = ts;
        const p = videoEl.play();
        if (p && typeof p.catch === "function") p.catch(() => {});
      } catch (err) {
        console.error("[BehavioralTimeline] seek failed:", err);
      }
    },
    [videoEl],
  );

  const overlayPortalTarget = useMemo(() => {
    if (!videoEl) return null;
    return videoEl.parentElement || null;
  }, [videoEl]);

  return (
    <section className="btp" aria-label="Recruiter behavioral timeline overlay">
      <header className="btp__header">
        <div className="btp__title-block">
          <h3 className="btp__title">Behavioral Timeline (Advisory)</h3>
          <p className="btp__subtitle">
            DeepFace overlay for recruiter review only. Does not affect
            scoring, reports, or hiring decisions.
          </p>
        </div>
        <label className="btp__toggle">
          <input
            type="checkbox"
            checked={showTimeline}
            onChange={(e) => setShowTimeline(e.target.checked)}
          />
          <span>Show Behavioral Timeline</span>
        </label>
      </header>

      {showTimeline && status === "loading" && (
        <div className="btp__status">Loading behavioral overlay…</div>
      )}
      {showTimeline && status === "running" && (
        <div className="btp__status">
          Analyzing recording — this can take a minute on first view.
        </div>
      )}
      {showTimeline && status === "unavailable" && (
        <div className="btp__status btp__status--muted">
          Behavioral timeline unavailable for this recording.
        </div>
      )}

      {showTimeline && status === "ready" && overlayPortalTarget &&
        ReactDOM.createPortal(
          <>
            <CanvasOverlay
              videoEl={videoEl}
              frameLandmarks={data?.frameLandmarks || []}
              activeEvent={activeEvent}
            />
            <FaceEmotionPanel videoEl={videoEl} activeEvent={activeEvent} />
          </>,
          overlayPortalTarget,
        )}

      {showTimeline && status === "ready" && (
        <div className="btp__strips">
          <div className="btp__strip-row">
            <span className="btp__strip-label">Timeline</span>
            <SafeLabelTimeline
              events={events}
              duration={duration}
              currentTime={currentTime}
              onSeek={handleSeek}
            />
          </div>
          <div className="btp__strip-row">
            <span className="btp__strip-label">Intensity</span>
            <HeatmapStrip data={heatmap} duration={duration} />
          </div>
          {summary && summary.dominantSignal && (
            <div className="btp__summary">
              <span>
                Dominant signal:{" "}
                <strong style={{ color: colorFor(summary.dominantSignal) }}>
                  {summary.dominantSignal}
                </strong>
              </span>
              <span>Variation moments: {summary.variationMoments || 0}</span>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
