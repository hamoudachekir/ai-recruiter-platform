import { useEffect, useRef } from 'react';

const SNAPSHOT_THROTTLE_MS = 30000;
const EVENT_COOLDOWN_MS = 45000;

const EVENT_RULES = [
  {
    type: 'NO_FACE',
    thresholdSeconds: 3,
    severity: 'medium',
    confidence: 0.88,
    when: (state) => !state.facePresent,
    evidence: (state, duration) => `No face detected for ${Math.round(duration)} seconds.`,
  },
  {
    type: 'MULTIPLE_PEOPLE',
    thresholdSeconds: 1,
    severity: 'high',
    confidence: 0.9,
    when: (state) => state.personCount === 'multiple' || Number(state.personCount) > 1,
    evidence: () => 'More than one face/person signal was detected in the camera frame.',
  },
  {
    type: 'LOOKING_AWAY_LONG',
    thresholdSeconds: 5,
    severity: 'medium',
    confidence: 0.78,
    when: (state) => !!state.lookingAway,
    evidence: (state, duration) => `Looking-away signal persisted for ${Math.round(duration)} seconds.`,
  },
  {
    type: 'BAD_LIGHTING',
    thresholdSeconds: 10,
    severity: 'low',
    confidence: 0.75,
    when: (state) => state.lightingQuality === 'poor',
    evidence: () => 'Lighting quality was poor for an extended period, which may reduce monitoring confidence.',
  },
  {
    type: 'FACE_TOO_FAR',
    thresholdSeconds: 5,
    severity: 'low',
    confidence: 0.75,
    when: (state) => state.distanceStatus && state.distanceStatus !== 'good',
    evidence: (state, duration) => `Face distance was ${state.distanceStatus} for ${Math.round(duration)} seconds.`,
  },
  {
    type: 'CAMERA_BLOCKED',
    thresholdSeconds: 2,
    severity: 'high',
    confidence: 0.86,
    when: (state) => !!state.cameraBlocked,
    evidence: () => 'Camera frame appeared blocked or mostly dark.',
  },
];

const useIntegrityEvents = ({
  active,
  interviewId,
  questionId,
  token,
  apiBase,
  visionState,
  videoRef,
}) => {
  const isEnabled = active && !!interviewId && !!token;
  const ruleStateRef = useRef({});
  const lastRuleEventAtRef = useRef({});
  const lastSnapshotAtRef = useRef(0);
  const lastBrowserEventAtRef = useRef({});
  const hiddenStartedAtRef = useRef(0);
  const lastFullscreenRef = useRef(!!document.fullscreenElement);
  const refs = useRef({ questionId, apiBase, token, interviewId, videoRef });

  useEffect(() => {
    refs.current = { questionId, apiBase, token, interviewId, videoRef };
  }, [questionId, apiBase, token, interviewId, videoRef]);

  const captureSnapshot = () => {
    const video = refs.current.videoRef?.current;
    if (!video || video.readyState < 2 || !video.videoWidth || !video.videoHeight) {
      return '';
    }

    try {
      const maxWidth = 480;
      const scale = Math.min(1, maxWidth / video.videoWidth);
      const width = Math.max(1, Math.round(video.videoWidth * scale));
      const height = Math.max(1, Math.round(video.videoHeight * scale));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(video, 0, 0, width, height);
      return canvas.toDataURL('image/jpeg', 0.68);
    } catch (error) {
      console.warn('Integrity snapshot capture failed:', error);
      return '';
    }
  };

  const postEvent = async (event) => {
    const {
      apiBase: currentApiBase,
      token: currentToken,
      interviewId: currentInterviewId,
      questionId: currentQuestionId,
    } = refs.current;
    if (!currentApiBase || !currentToken || !currentInterviewId) return;

    const payload = {
      ...event,
      questionId: event.questionId ?? currentQuestionId ?? '',
      timestamp: event.timestamp || new Date().toISOString(),
    };

    if ((payload.severity === 'medium' || payload.severity === 'high')) {
      const now = Date.now();
      if (now - lastSnapshotAtRef.current >= SNAPSHOT_THROTTLE_MS) {
        const snapshotBase64 = captureSnapshot();
        if (snapshotBase64) {
          payload.snapshotBase64 = snapshotBase64;
          lastSnapshotAtRef.current = now;
        }
      }
    }

    try {
      await fetch(`${currentApiBase}/api/interviews/${currentInterviewId}/vision-event`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${currentToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      console.warn('Failed to post integrity event:', err);
    }
  };

  useEffect(() => {
    if (!isEnabled || !visionState) return;

    const now = Date.now();
    for (const rule of EVENT_RULES) {
      const activeRule = rule.when(visionState);
      const existing = ruleStateRef.current[rule.type];

      if (!activeRule) {
        delete ruleStateRef.current[rule.type];
        continue;
      }

      const state = existing || { startedAt: now, emitted: false };
      ruleStateRef.current[rule.type] = state;
      const durationSeconds = (now - state.startedAt) / 1000;
      const lastEventAt = lastRuleEventAtRef.current[rule.type] || 0;
      const cooledDown = now - lastEventAt >= EVENT_COOLDOWN_MS;

      if (!state.emitted && cooledDown && durationSeconds >= rule.thresholdSeconds) {
        state.emitted = true;
        lastRuleEventAtRef.current[rule.type] = now;
        void postEvent({
          type: rule.type,
          severity: rule.severity,
          durationSeconds,
          confidence: rule.confidence,
          evidence: rule.evidence(visionState, durationSeconds),
        });
      }
    }
  }, [isEnabled, visionState]);

  useEffect(() => {
    if (!isEnabled) return undefined;

    const emitBrowserEvent = (type, severity, evidence, durationSeconds = 0) => {
      const now = Date.now();
      const last = lastBrowserEventAtRef.current[type] || 0;
      if (now - last < 10000) return;
      lastBrowserEventAtRef.current[type] = now;
      void postEvent({
        type,
        severity,
        durationSeconds,
        confidence: 1,
        evidence,
      });
    };

    const handleVisibilityChange = () => {
      if (document.hidden) {
        hiddenStartedAtRef.current = Date.now();
        return;
      }

      if (hiddenStartedAtRef.current) {
        const durationSeconds = (Date.now() - hiddenStartedAtRef.current) / 1000;
        hiddenStartedAtRef.current = 0;
        emitBrowserEvent(
          'TAB_SWITCH',
          'medium',
          'Browser window lost focus during the interview.',
          durationSeconds,
        );
      }
    };

    const handleFullscreenChange = () => {
      const isFullscreen = !!document.fullscreenElement;
      if (!isFullscreen && lastFullscreenRef.current) {
        emitBrowserEvent('FULLSCREEN_EXIT', 'medium', 'Fullscreen mode was exited during the interview.');
      }
      lastFullscreenRef.current = isFullscreen;
    };

    const handleCopyPaste = (event) => {
      emitBrowserEvent(
        'COPY_PASTE',
        'medium',
        `${event.type === 'copy' ? 'Copy' : 'Paste'} action occurred inside the interview page.`,
      );
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('copy', handleCopyPaste);
    document.addEventListener('paste', handleCopyPaste);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      document.removeEventListener('copy', handleCopyPaste);
      document.removeEventListener('paste', handleCopyPaste);
    };
  }, [isEnabled]);
};

export default useIntegrityEvents;
