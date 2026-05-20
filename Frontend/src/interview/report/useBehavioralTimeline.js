/**
 * Recruiter-only behavioral timeline overlay hook.
 *
 * Advisory-only. Lazily fetches DeepFace overlay data on toggle-on, caches the
 * result for the component's lifetime, and never throws — any error becomes
 * a `status: "unavailable"` state so the video player is unaffected.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import {
  getBehavioralTimeline,
  requestBehavioralTimelineAnalysis,
} from "../../services/analysisApi";

const POLL_INTERVAL_MS = 4000;
const MAX_POLL_ATTEMPTS = 30; // ~2 minutes

export function useBehavioralTimeline({ interviewId, enabled }) {
  const [data, setData] = useState(null); // { events, heatmap, summary }
  const [status, setStatus] = useState("idle"); // idle | loading | ready | running | unavailable
  const pollAttemptsRef = useRef(0);
  const pollTimerRef = useRef(null);
  const hasTriggeredAnalyzeRef = useRef(false);

  const clearPoll = useCallback(() => {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const loadOnce = useCallback(async () => {
    if (!interviewId) return null;
    const payload = await getBehavioralTimeline(interviewId);
    if (payload && payload.ok && Array.isArray(payload.events)) {
      return payload;
    }
    return null;
  }, [interviewId]);

  const triggerAnalyze = useCallback(async () => {
    if (!interviewId || hasTriggeredAnalyzeRef.current) return;
    hasTriggeredAnalyzeRef.current = true;
    const resp = await requestBehavioralTimelineAnalysis(interviewId);
    // If the trigger responded with an already-cached payload, use it.
    if (resp && resp.ok && Array.isArray(resp.events) && resp.events.length >= 0) {
      setData({
        events: resp.events || [],
        heatmap: resp.heatmap || [],
        summary: resp.summary || {},
        emotionSummary: resp.emotionSummary || null,
        frameLandmarks: resp.frameLandmarks || [],
      });
      setStatus("ready");
    }
  }, [interviewId]);

  const poll = useCallback(async () => {
    pollAttemptsRef.current += 1;
    const payload = await loadOnce();
    if (payload) {
      setData({
        events: payload.events || [],
        heatmap: payload.heatmap || [],
        summary: payload.summary || {},
        emotionSummary: payload.emotionSummary || null,
        frameLandmarks: payload.frameLandmarks || [],
      });
      setStatus("ready");
      clearPoll();
      return;
    }
    if (pollAttemptsRef.current >= MAX_POLL_ATTEMPTS) {
      setStatus("unavailable");
      clearPoll();
      return;
    }
    pollTimerRef.current = setTimeout(poll, POLL_INTERVAL_MS);
  }, [clearPoll, loadOnce]);

  useEffect(() => {
    if (!enabled) {
      clearPoll();
      return;
    }
    if (!interviewId) return;
    if (data) return; // cached for this session

    let cancelled = false;
    setStatus("loading");
    (async () => {
      const payload = await loadOnce();
      if (cancelled) return;
      if (payload) {
        setData({
          events: payload.events || [],
          heatmap: payload.heatmap || [],
          summary: payload.summary || {},
          emotionSummary: payload.emotionSummary || null,
          frameLandmarks: payload.frameLandmarks || [],
        });
        setStatus("ready");
        return;
      }
      // Not analyzed yet — kick off the pipeline and poll.
      setStatus("running");
      await triggerAnalyze();
      if (cancelled) return;
      pollAttemptsRef.current = 0;
      poll();
    })();

    return () => {
      cancelled = true;
      clearPoll();
    };
  }, [enabled, interviewId, data, loadOnce, poll, triggerAnalyze, clearPoll]);

  return { data, status };
}
