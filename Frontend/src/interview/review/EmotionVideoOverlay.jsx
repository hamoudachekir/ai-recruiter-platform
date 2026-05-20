/**
 * EmotionVideoOverlay
 *
 * Reusable animated emotion layer that sits on top of a <video> element.
 * Drives off the same behavioral-timeline events the recruiter dashboard
 * already consumes — picks the active event based on the video's current
 * playback time, then renders:
 *
 *   • a floating emoji that tracks the candidate's face
 *   • a trailing pill at the bottom-center showing the last 8 emotions
 *   • a live label card pinned to the right
 *   • a soft inner glow tinted by the dominant emotion's color
 *
 * Used by both:
 *   - CandidateSelfReview (full-screen reflection page)
 *   - InterviewMediaPanel  (recruiter report video tab)
 *
 * Pure presentation — never re-fetches data, never mutates anything.
 */
import { useEffect, useMemo, useState } from "react";

import "./EmotionVideoOverlay.css";

const EMOTION_VISUALS = {
  happy: { emoji: "😊", color: "#4ade80", glow: "rgba(74, 222, 128, 0.42)" },
  sad: { emoji: "😢", color: "#60a5fa", glow: "rgba(96, 165, 250, 0.42)" },
  angry: { emoji: "😠", color: "#f87171", glow: "rgba(248, 113, 113, 0.42)" },
  fear: { emoji: "😨", color: "#fbbf24", glow: "rgba(251, 191, 36, 0.42)" },
  surprise: { emoji: "😲", color: "#a3e635", glow: "rgba(163, 230, 53, 0.42)" },
  disgust: { emoji: "🤢", color: "#a16207", glow: "rgba(161, 98, 7, 0.42)" },
  neutral: { emoji: "😐", color: "#94a3b8", glow: "rgba(148, 163, 184, 0.32)" },
};

function visualFor(emotion) {
  return EMOTION_VISUALS[emotion] || EMOTION_VISUALS.neutral;
}

function dominantFromRawScores(raw) {
  if (!raw || typeof raw !== "object") return "neutral";
  const entries = Object.entries(raw);
  if (!entries.length) return "neutral";
  entries.sort((a, b) => Number(b[1]) - Number(a[1]));
  return entries[0][0];
}

export default function EmotionVideoOverlay({
  videoEl,
  events,
  enabled = true,
  showLiveCard = true,
  showStream = true,
  showGlow = true,
  showFloating = true,
}) {
  const [currentFrame, setCurrentFrame] = useState(null);
  const [emotionStream, setEmotionStream] = useState([]);

  // Build a per-event lookup so we can resolve the active emotion as the
  // video time updates. Skipping events that lack face_box data avoids
  // popping the floating emoji to a stale position.
  const frameMap = useMemo(() => {
    if (!Array.isArray(events)) return [];
    return events.map((e) => ({
      start: Number(e.timestamp) || 0,
      end: (Number(e.timestamp) || 0) + (Number(e.duration) || 0),
      emotion: dominantFromRawScores(e.raw_scores),
      label: e.label,
      confidence: Number(e.confidence) || 0,
      faceBox: e.face_box || null,
      frameW: Number(e.frame_width) || 0,
      frameH: Number(e.frame_height) || 0,
    }));
  }, [events]);

  useEffect(() => {
    if (!enabled || !videoEl || !frameMap.length) {
      setCurrentFrame(null);
      setEmotionStream([]);
      return undefined;
    }

    let rafId;
    const update = () => {
      const t = Number(videoEl.currentTime) || 0;
      const active = frameMap.find((f) => t >= f.start && t <= f.end) || null;
      setCurrentFrame((prev) => {
        if (
          prev &&
          active &&
          prev.start === active.start &&
          prev.end === active.end
        ) {
          return prev;
        }
        return active;
      });

      if (active) {
        setEmotionStream((prev) => {
          if (prev.length && prev[prev.length - 1].id === active.start) {
            return prev;
          }
          const next = [...prev, { ...active, id: active.start }];
          return next.slice(-8);
        });
      }
      rafId = requestAnimationFrame(update);
    };

    rafId = requestAnimationFrame(update);
    return () => cancelAnimationFrame(rafId);
  }, [enabled, videoEl, frameMap]);

  if (!enabled || !frameMap.length) return null;

  const visual = visualFor(currentFrame?.emotion);

  return (
    <div className="evo-layer" aria-hidden="true">
      {showGlow && (
        <div
          className="evo-glow"
          style={{ boxShadow: `inset 0 0 80px 8px ${visual.glow}` }}
        />
      )}

      {showFloating &&
        currentFrame?.faceBox &&
        currentFrame.frameW > 0 &&
        currentFrame.frameH > 0 && (
          <div
            className="evo-floating"
            style={{
              left: `${
                ((currentFrame.faceBox.x + currentFrame.faceBox.w / 2) /
                  currentFrame.frameW) *
                100
              }%`,
              top: `${(currentFrame.faceBox.y / currentFrame.frameH) * 100}%`,
              color: visual.color,
              textShadow: `0 0 24px ${visual.glow}`,
            }}
          >
            <span className="evo-floating__emoji">{visual.emoji}</span>
          </div>
        )}

      {showStream && emotionStream.length > 0 && (
        <div className="evo-stream">
          {emotionStream.map((e, idx) => {
            const v = visualFor(e.emotion);
            return (
              <span
                key={e.id}
                className="evo-stream__emoji"
                style={{
                  opacity: (idx + 1) / emotionStream.length,
                  color: v.color,
                }}
              >
                {v.emoji}
              </span>
            );
          })}
        </div>
      )}

      {showLiveCard && currentFrame && (
        <div
          className="evo-live-card"
          style={{ borderLeftColor: visual.color }}
        >
          <span className="evo-live-card__emoji">{visual.emoji}</span>
          <div className="evo-live-card__text">
            <div className="evo-live-card__emotion">{currentFrame.emotion}</div>
            <div className="evo-live-card__confidence">
              {Math.round((currentFrame.confidence || 0) * 100)}% confidence
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
