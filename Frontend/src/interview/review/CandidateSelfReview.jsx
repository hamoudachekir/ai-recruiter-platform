/**
 * CandidateSelfReview
 *
 * Candidate-facing replay of their own interview with the recorded video
 * playing back and emotion overlays animating in real-time on top of it.
 *
 * UX rule: supportive, never judgmental. Language stays growth-oriented.
 * The recruiter pipeline is unchanged — this page consumes the same
 * advisory behavioral-timeline data the recruiter dashboard already does.
 */
import { useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";

import { useBehavioralTimeline } from "../report/useBehavioralTimeline";
import EmotionVideoOverlay from "./EmotionVideoOverlay";
import "./CandidateSelfReview.css";

const API_BASE =
  import.meta.env.VITE_API_BASE_URL || "http://localhost:3001";

function generateCandidateSummary(s) {
  if (!s) return null;
  const { dominantEmotion, engagementArc, stressLevel } = s;
  if (engagementArc === "rising") {
    return "You appeared to grow more engaged as the interview progressed — a great sign of comfort building over time. 🌱";
  }
  if (stressLevel === "low" && dominantEmotion === "neutral") {
    return "You maintained a calm, composed presence throughout — projecting professionalism and steadiness. ✨";
  }
  if (dominantEmotion === "happy") {
    return "Your warmth and positive energy came through clearly — a memorable impression. 🌟";
  }
  if (stressLevel === "high") {
    return "You showed real moments of pressure — completely natural in interviews. Slow breathing and short pauses can help next time. 💪";
  }
  if (engagementArc === "falling") {
    return "Energy dipped a bit toward the end — totally normal. Practicing endurance through mock interviews can help you stay sharp the whole way through. 🎯";
  }
  return "Every interview is practice. Reviewing your own expressions is a powerful way to grow. 📈";
}

export default function CandidateSelfReview() {
  const { interviewId } = useParams();
  const videoRef = useRef(null);
  const [videoEl, setVideoEl] = useState(null);

  const { data, status } = useBehavioralTimeline({
    interviewId,
    enabled: !!interviewId,
  });

  const isLoading = status === "loading" || status === "running";
  const unavailable = status === "unavailable";

  const videoUrl = useMemo(
    () =>
      interviewId
        ? `${API_BASE}/api/call-rooms/${encodeURIComponent(interviewId)}/recording`
        : "",
    [interviewId],
  );

  if (!interviewId) {
    return (
      <div className="csr-shell">
        <div className="csr-empty">
          <h2>Replay not found</h2>
          <p>The interview ID is missing from the URL.</p>
        </div>
      </div>
    );
  }

  const summarySentence = generateCandidateSummary(data?.emotionSummary);

  return (
    <div className="csr-shell">
      <header className="csr-header">
        <h1>🪞 Your Interview Replay</h1>
        <p className="csr-subtitle">
          Watch yourself with emotion insights — a personal reflection tool.
          These signals are <strong>advisory</strong> and never affect your evaluation.
        </p>
      </header>

      {isLoading && (
        <div className="csr-loading">
          <div className="csr-loading__emoji">🎭</div>
          <h2>Analyzing your interview…</h2>
          <p>We&apos;re preparing your emotion replay. This usually takes 1–2 minutes.</p>
        </div>
      )}

      {unavailable && (
        <div className="csr-empty">
          <h2>Replay not ready yet</h2>
          <p>
            Your interview recording is still being processed. Refresh in a
            minute or two and your emotion replay will appear here.
          </p>
        </div>
      )}

      {!isLoading && !unavailable && (
        <>
          <div className="csr-stage">
            <video
              ref={(el) => {
                videoRef.current = el;
                setVideoEl(el);
              }}
              src={videoUrl}
              controls
              preload="metadata"
              className="csr-video"
              onLoadedMetadata={(e) => {
                // Same WebM Infinity-duration workaround used on the recruiter side
                const v = e.target;
                if (!Number.isFinite(Number(v.duration)) || Number(v.duration) <= 0) {
                  const onSeeked = () => {
                    v.removeEventListener("seeked", onSeeked);
                    try { v.currentTime = 0; } catch (_e) { /* ignore */ }
                  };
                  v.addEventListener("seeked", onSeeked);
                  try { v.currentTime = 1e9; } catch (_e) { /* ignore */ }
                }
              }}
            />

            <EmotionVideoOverlay
              videoEl={videoEl}
              events={data?.events || []}
              enabled
            />
          </div>

          {summarySentence && (
            <div className="csr-summary">
              <h3>📊 Your Emotional Journey</h3>
              <p>{summarySentence}</p>
            </div>
          )}

          <footer className="csr-footer">
            ℹ️ This replay is <strong>for your reflection only</strong>. Emotion
            signals do not influence your evaluation or hiring decisions.
          </footer>
        </>
      )}
    </div>
  );
}
