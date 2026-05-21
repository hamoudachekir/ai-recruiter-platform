/**
 * RecordedVideoFaceMask
 *
 * Professional face-tracking overlay drawn on top of a recorded interview
 * <video>. Uses MediaPipe FaceLandmarker (VIDEO mode, 478 landmarks with
 * iris refinement + 52 blendshapes) and renders:
 *
 *   • A corner-bracket tracking box around the face (AI-tracking aesthetic)
 *   • Face oval contour
 *   • Eyebrows (left + right)
 *   • Eye outlines + iris fill (left + right)
 *   • Nose bridge
 *   • Outer + inner lips
 *   • A live HUD panel showing dominant sentiment, intensity bar, and the
 *     top 3 blendshape signals
 *
 * Blendshape scores are smoothed with an exponential moving average so the
 * sentiment label and intensity bar stay stable instead of flickering.
 *
 * Pure presentation — no API calls, no state mutation beyond local state.
 */
import { useEffect, useRef, useState } from "react";
import { FilesetResolver, FaceLandmarker } from "@mediapipe/tasks-vision";

import "./RecordedVideoFaceMask.css";

// ── Sentiment / blendshape config ────────────────────────────────────────────
const SENTIMENT_META = {
  happy: { color: "#22d3a4", emoji: "😊", label: "Happy" },
  sad: { color: "#60a5fa", emoji: "😢", label: "Sad" },
  angry: { color: "#f87171", emoji: "😠", label: "Angry" },
  surprised: { color: "#a3e635", emoji: "😲", label: "Surprised" },
  fear: { color: "#fbbf24", emoji: "😨", label: "Tense" },
  disgust: { color: "#c084fc", emoji: "🤢", label: "Disgust" },
  neutral: { color: "#94a3b8", emoji: "😐", label: "Neutral" },
};

const PRIMARY = "rgba(56, 224, 217, 0.92)";

// Exponential moving average alpha (lower = smoother)
const EMA_ALPHA = 0.35;
const SENTIMENT_HYSTERESIS = 0.08;
const FRAME_INTERVAL_MS = 70; // ~14 FPS — smooth enough, easy on CPU

// ── Helpers ──────────────────────────────────────────────────────────────────
const drawCornerBrackets = (ctx, x, y, w, h, color) => {
  const len = Math.min(w, h) * 0.18;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.lineCap = "round";
  const corners = [
    [x, y, 1, 1],
    [x + w, y, -1, 1],
    [x, y + h, 1, -1],
    [x + w, y + h, -1, -1],
  ];
  corners.forEach(([cx, cy, dx, dy]) => {
    ctx.beginPath();
    ctx.moveTo(cx + dx * len, cy);
    ctx.lineTo(cx, cy);
    ctx.lineTo(cx, cy + dy * len);
    ctx.stroke();
  });
};

// Pick a sentiment from smoothed blendshape EMAs. `current` is passed so we
// can add a tiny hysteresis — a competing category must beat the current one
// by SENTIMENT_HYSTERESIS to take over (prevents rapid flipping).
const sentimentFromScores = (s, current) => {
  if (!s) return "neutral";
  const v = (k) => Math.max(0, s[k] || 0);
  const maxPair = (a, b) => Math.max(v(a), v(b));

  const smile = maxPair("mouthSmileLeft", "mouthSmileRight");
  const frown = maxPair("mouthFrownLeft", "mouthFrownRight");
  const browDown = maxPair("browDownLeft", "browDownRight");
  const browInnerUp = v("browInnerUp");
  const browOuterUp = maxPair("browOuterUpLeft", "browOuterUpRight");
  const eyeSquint = maxPair("eyeSquintLeft", "eyeSquintRight");
  const eyeWide = maxPair("eyeWideLeft", "eyeWideRight");
  const jawOpen = v("jawOpen");
  const jawForward = v("jawForward");
  const noseSneer = maxPair("noseSneerLeft", "noseSneerRight");
  const upperLipUp = maxPair("mouthUpperUpLeft", "mouthUpperUpRight");
  const lipPress = maxPair("mouthPressLeft", "mouthPressRight");

  const scores = {
    happy: smile * 1.2,
    surprised: jawOpen * 0.7 + eyeWide * 0.7 + browOuterUp * 0.5,
    angry: browDown * 1.0 + eyeSquint * 0.5 + jawForward * 0.4 + lipPress * 0.4,
    sad: frown * 1.0 + browInnerUp * 0.4,
    fear: browInnerUp * 0.7 + eyeWide * 0.5,
    disgust: noseSneer * 1.1 + upperLipUp * 0.7,
    neutral: 0.18,
  };

  let best = "neutral";
  let bestScore = 0;
  for (const [k, val] of Object.entries(scores)) {
    if (val > bestScore) {
      best = k;
      bestScore = val;
    }
  }
  if (current && best !== current) {
    const currentScore = scores[current] || 0;
    if (bestScore - currentScore < SENTIMENT_HYSTERESIS) return current;
  }
  return best;
};

const intensityFromScores = (s) => {
  if (!s) return 0;
  const peak = Math.max(
    s.mouthSmileLeft || 0,
    s.mouthSmileRight || 0,
    s.mouthFrownLeft || 0,
    s.mouthFrownRight || 0,
    s.browDownLeft || 0,
    s.browDownRight || 0,
    s.browInnerUp || 0,
    s.jawOpen || 0,
  );
  return Math.min(1, peak * 1.4);
};

const formatPct = (v) => Math.round(Math.max(0, Math.min(1, v)) * 100);

// Map smoothed blendshape scores to a 7-emotion probability distribution
// compatible with the existing EmotionDashboard breakdown / timeline / peaks.
// Output is normalized so values sum to 1.
//
// Each emotion blends multiple MediaPipe blendshapes (FACS-style action units)
// without strict gates, so subtle expressions still register instead of being
// dropped to ~0 and overwhelmed by neutral.
const blendshapesToEmotionProbs = (s) => {
  const empty = {
    neutral: 1,
    happy: 0,
    sad: 0,
    fear: 0,
    angry: 0,
    surprise: 0,
    disgust: 0,
  };
  if (!s) return empty;

  const v = (k) => Math.max(0, s[k] || 0);
  const maxPair = (a, b) => Math.max(v(a), v(b));

  const smile = maxPair("mouthSmileLeft", "mouthSmileRight");
  const dimple = maxPair("mouthDimpleLeft", "mouthDimpleRight");
  const cheekSquint = maxPair("cheekSquintLeft", "cheekSquintRight");

  const frown = maxPair("mouthFrownLeft", "mouthFrownRight");
  const mouthStretch = maxPair("mouthStretchLeft", "mouthStretchRight");
  const browInnerUp = v("browInnerUp");
  const browDown = maxPair("browDownLeft", "browDownRight");
  const browOuterUp = maxPair("browOuterUpLeft", "browOuterUpRight");
  const eyeSquint = maxPair("eyeSquintLeft", "eyeSquintRight");
  const eyeWide = maxPair("eyeWideLeft", "eyeWideRight");
  const jawOpen = v("jawOpen");
  const jawForward = v("jawForward");
  const noseSneer = maxPair("noseSneerLeft", "noseSneerRight");
  const upperLipUp = maxPair("mouthUpperUpLeft", "mouthUpperUpRight");
  const lipPress = maxPair("mouthPressLeft", "mouthPressRight");
  const mouthFunnel = v("mouthFunnel");
  const mouthPucker = v("mouthPucker");

  // Each emotion gets multiple cues, gently weighted. No hard thresholds —
  // subtle micro-expressions surface as low (but non-zero) probabilities.
  const raw = {
    happy: smile * 1.2 + dimple * 0.6 + cheekSquint * 0.4,
    sad:
      frown * 1.1 +
      browInnerUp * 0.5 +
      mouthStretch * 0.3 +
      (browInnerUp > 0.2 && browDown > 0.15 ? 0.25 : 0),
    angry:
      browDown * 1.1 +
      eyeSquint * 0.5 +
      jawForward * 0.4 +
      lipPress * 0.5 +
      noseSneer * 0.3,
    surprise:
      jawOpen * 0.9 +
      eyeWide * 0.9 +
      browOuterUp * 0.6 +
      browInnerUp * 0.4 +
      mouthFunnel * 0.3,
    fear:
      browInnerUp * 0.7 +
      eyeWide * 0.6 +
      mouthStretch * 0.4 +
      (browInnerUp > 0.25 && eyeWide > 0.2 ? 0.3 : 0),
    disgust:
      noseSneer * 1.2 +
      upperLipUp * 0.8 +
      browDown * 0.4 +
      mouthPucker * 0.3,
  };

  const sumRaw =
    raw.happy + raw.sad + raw.angry + raw.surprise + raw.fear + raw.disgust;
  // Residual mass = neutral. Multiplier (1.1) is lower than before so an
  // active face doesn't collapse all non-neutral signals to near-zero.
  const neutralWeight = Math.max(0.05, 1 - sumRaw * 1.1);
  const total = sumRaw + neutralWeight || 1;
  return {
    neutral: neutralWeight / total,
    happy: raw.happy / total,
    sad: raw.sad / total,
    fear: raw.fear / total,
    angry: raw.angry / total,
    surprise: raw.surprise / total,
    disgust: raw.disgust / total,
  };
};

// ── Component ────────────────────────────────────────────────────────────────
export default function RecordedVideoFaceMask({
  videoEl,
  enabled = true,
  onSample,
}) {
  const canvasRef = useRef(null);
  const detectorRef = useRef(null);
  const rafRef = useRef(null);
  const lastDetectTimeRef = useRef(0);
  const lastSampleEmitRef = useRef(0);
  const emaScoresRef = useRef({});
  const sentimentRef = useRef("neutral");
  const onSampleRef = useRef(onSample);
  useEffect(() => {
    onSampleRef.current = onSample;
  }, [onSample]);

  const [sentiment, setSentiment] = useState("neutral");
  const [intensity, setIntensity] = useState(0);
  const [topSignals, setTopSignals] = useState([]);
  const [hasFace, setHasFace] = useState(false);
  const [ready, setReady] = useState(false);

  // ── Initialise MediaPipe FaceLandmarker ────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    const setup = async () => {
      try {
        const filesetResolver = await FilesetResolver.forVisionTasks(
          "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm",
        );
        const detector = await FaceLandmarker.createFromOptions(
          filesetResolver,
          {
            baseOptions: {
              modelAssetPath:
                "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
              delegate: "CPU",
            },
            runningMode: "VIDEO",
            numFaces: 1,
            outputFaceBlendshapes: true,
            outputFacialTransformationMatrixes: false,
            minFaceDetectionConfidence: 0.5,
            minFacePresenceConfidence: 0.5,
            minTrackingConfidence: 0.5,
          },
        );
        if (cancelled) {
          detector.close?.();
          return;
        }
        detectorRef.current = detector;
        setReady(true);
      } catch (err) {
        console.warn("[RecordedVideoFaceMask] init failed:", err);
      }
    };
    setup();
    return () => {
      cancelled = true;
      detectorRef.current?.close?.();
      detectorRef.current = null;
    };
  }, []);

  // ── Per-frame detect + draw loop ───────────────────────────────────────────
  useEffect(() => {
    if (!enabled || !ready || !videoEl) return undefined;
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const ctx = canvas.getContext("2d");
    if (!ctx) return undefined;

    const loop = (ts) => {
      const detector = detectorRef.current;
      const video = videoEl;
      if (!detector || !video) {
        rafRef.current = requestAnimationFrame(loop);
        return;
      }

      if (video.paused || video.ended || video.readyState < 2) {
        rafRef.current = requestAnimationFrame(loop);
        return;
      }

      if (ts - lastDetectTimeRef.current < FRAME_INTERVAL_MS) {
        rafRef.current = requestAnimationFrame(loop);
        return;
      }
      lastDetectTimeRef.current = ts;

      const vw = video.videoWidth || 640;
      const vh = video.videoHeight || 480;
      if (canvas.width !== vw) canvas.width = vw;
      if (canvas.height !== vh) canvas.height = vh;
      ctx.clearRect(0, 0, vw, vh);

      let result;
      try {
        result = detector.detectForVideo(video, ts);
      } catch (_err) {
        // VIDEO mode wants monotonic timestamps — backwards seek throws.
        rafRef.current = requestAnimationFrame(loop);
        return;
      }

      const landmarks = result?.faceLandmarks?.[0];
      if (!landmarks || !landmarks.length) {
        if (hasFace) setHasFace(false);
        rafRef.current = requestAnimationFrame(loop);
        return;
      }
      if (!hasFace) setHasFace(true);

      // ── Smooth blendshape scores with an EMA ─────────────────────────────
      const bs = result?.faceBlendshapes?.[0];
      if (bs?.categories) {
        const ema = emaScoresRef.current;
        for (const cat of bs.categories) {
          const prev = ema[cat.categoryName] || 0;
          ema[cat.categoryName] = prev + EMA_ALPHA * (cat.score - prev);
        }
      }
      const ema = emaScoresRef.current;
      const nextSentiment = sentimentFromScores(ema, sentimentRef.current);
      if (nextSentiment !== sentimentRef.current) {
        sentimentRef.current = nextSentiment;
        setSentiment(nextSentiment);
      }
      const nextIntensity = intensityFromScores(ema);
      setIntensity(nextIntensity);

      // Emit a sample to the parent at most twice per second, so the
      // emotion-summary aggregator below the video has data to work with.
      if (
        typeof onSampleRef.current === "function" &&
        ts - lastSampleEmitRef.current >= 500
      ) {
        lastSampleEmitRef.current = ts;
        try {
          onSampleRef.current({
            timestamp: Number(video.currentTime) || 0,
            probs: blendshapesToEmotionProbs(ema),
          });
        } catch (_err) { /* never throw out of the loop */ }
      }

      // Top 3 blendshapes for the HUD readout (excluding noisy basics)
      const NOISY = new Set([
        "_neutral",
        "eyeBlinkLeft",
        "eyeBlinkRight",
        "eyeLookDownLeft",
        "eyeLookDownRight",
        "eyeLookInLeft",
        "eyeLookInRight",
        "eyeLookOutLeft",
        "eyeLookOutRight",
        "eyeLookUpLeft",
        "eyeLookUpRight",
        "eyeSquintLeft",
        "eyeSquintRight",
        "eyeWideLeft",
        "eyeWideRight",
      ]);
      const ranked = Object.entries(ema)
        .filter(([k]) => !NOISY.has(k))
        .sort(([, a], [, b]) => b - a)
        .slice(0, 3)
        .map(([k, v]) => ({ name: k, value: v }));
      setTopSignals(ranked);

      const sentimentColor =
        SENTIMENT_META[nextSentiment]?.color || PRIMARY;

      // ── Compute face bounding box from landmarks ─────────────────────────
      let minX = 1;
      let maxX = 0;
      let minY = 1;
      let maxY = 0;
      for (const lm of landmarks) {
        if (lm.x < minX) minX = lm.x;
        if (lm.x > maxX) maxX = lm.x;
        if (lm.y < minY) minY = lm.y;
        if (lm.y > maxY) maxY = lm.y;
      }
      const padX = (maxX - minX) * 0.12;
      const padY = (maxY - minY) * 0.18;
      const bx = Math.max(0, (minX - padX) * vw);
      const by = Math.max(0, (minY - padY) * vh);
      const bw = Math.min(vw - bx, (maxX - minX + padX * 2) * vw);
      const bh = Math.min(vh - by, (maxY - minY + padY * 2) * vh);

      // ── Draw layers (cadre only — no landmark overlay on the face) ──────
      ctx.save();
      ctx.shadowColor = sentimentColor;
      ctx.shadowBlur = 6;
      drawCornerBrackets(ctx, bx, by, bw, bh, sentimentColor);
      ctx.restore();

      rafRef.current = requestAnimationFrame(loop);
    };

    rafRef.current = requestAnimationFrame(loop);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    };
  }, [enabled, ready, videoEl, hasFace]);

  // Reset EMA when the user seeks (video.currentTime jumps).
  useEffect(() => {
    if (!videoEl) return undefined;
    const onSeek = () => {
      emaScoresRef.current = {};
      sentimentRef.current = "neutral";
    };
    videoEl.addEventListener("seeking", onSeek);
    return () => videoEl.removeEventListener("seeking", onSeek);
  }, [videoEl]);

  if (!enabled) return null;

  const meta = SENTIMENT_META[sentiment] || SENTIMENT_META.neutral;
  const intensityPct = formatPct(intensity);

  return (
    <>
      <canvas ref={canvasRef} className="rvfm-canvas" aria-hidden="true" />
      <div
        className={`rvfm-hud ${hasFace ? "rvfm-hud--active" : "rvfm-hud--idle"}`}
      >
        <div className="rvfm-hud__head">
          <span className="rvfm-hud__pulse" style={{ background: meta.color }} />
          <span className="rvfm-hud__title">Face Analysis</span>
          <span className="rvfm-hud__status">
            {hasFace ? "LIVE" : ready ? "STANDBY" : "INIT"}
          </span>
        </div>

        <div className="rvfm-hud__sentiment">
          <span className="rvfm-hud__emoji">{meta.emoji}</span>
          <div className="rvfm-hud__sentiment-text">
            <span
              className="rvfm-hud__sentiment-label"
              style={{ color: meta.color }}
            >
              {meta.label}
            </span>
            <span className="rvfm-hud__sentiment-sub">
              Intensity {intensityPct}%
            </span>
          </div>
        </div>

        <div className="rvfm-hud__bar" aria-hidden="true">
          <span
            className="rvfm-hud__bar-fill"
            style={{
              width: `${intensityPct}%`,
              background: `linear-gradient(90deg, ${meta.color}aa, ${meta.color})`,
            }}
          />
        </div>

        {topSignals.length > 0 && hasFace && (
          <div className="rvfm-hud__signals">
            {topSignals.map((sig) => (
              <div key={sig.name} className="rvfm-hud__signal">
                <span className="rvfm-hud__signal-name">
                  {sig.name.replace(/([A-Z])/g, " $1").trim()}
                </span>
                <span className="rvfm-hud__signal-bar">
                  <span
                    className="rvfm-hud__signal-fill"
                    style={{ width: `${formatPct(sig.value)}%` }}
                  />
                </span>
              </div>
            ))}
          </div>
        )}

        <div className="rvfm-hud__footer">Advisory · Local · No scoring impact</div>
      </div>
    </>
  );
}
