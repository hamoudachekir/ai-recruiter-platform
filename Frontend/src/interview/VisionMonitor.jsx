import { useEffect, useMemo, useRef, useState } from 'react';
import { FilesetResolver, FaceLandmarker } from '@mediapipe/tasks-vision';
import useYoloVision from './hooks/useYoloVision';
import './VisionMonitor.css';

const ANALYSIS_INTERVAL_MS = 200; // 5 FPS
const PRECHECK_POST_INTERVAL_MS = 3000;
const SMOOTHING_WINDOW = 7;
const STABLE_FACE_MIN = 3;
const STABLE_ISSUE_MIN = 4;
const CENTER_TOLERANCE_X = 0.18;
const CENTER_TOLERANCE_Y = 0.20;
const MIN_FACE_RATIO = 0.12;
const MAX_FACE_RATIO = 0.55;
const POOR_BRIGHTNESS_LOW = 40;
const POOR_BRIGHTNESS_HIGH = 235;
const GOOD_BRIGHTNESS_LOW = 70;
const GOOD_BRIGHTNESS_HIGH = 205;
const BLUR_THRESHOLD = 7.5;

const initialStatus = {
  facePresent: false,
  faceDetected: false,
  faceCentered: false,
  centered: false,
  lightingQuality: 'medium',
  lightingOk: true,
  personCount: 0,
  multipleFaces: false,
  distanceStatus: 'good',
  distanceOk: true,
  lookingAway: false,
  lookingAwayDurationSeconds: 0,
  candidateAbsentDurationSeconds: 0,
  cameraBlocked: false,
  unstableFrame: false,
  blurryFrame: false,
  brightness: 0,
  faceRatio: 0,
  message: 'Camera monitoring inactive',
};

const resetSummary = () => ({
  totalChecks: 0,
  faceDetectedChecks: 0,
  noFaceChecks: 0,
  multipleFacesChecks: 0,
  lightingIssueChecks: 0,
  positionIssueChecks: 0,
  distanceIssueChecks: 0,
});

const getBrightnessFromCanvas = (canvas, ctx) => {
  const { width, height } = canvas;
  const imageData = ctx.getImageData(0, 0, width, height).data;
  let sum = 0;
  let count = 0;

  for (let i = 0; i < imageData.length; i += 16) {
    const r = imageData[i];
    const g = imageData[i + 1];
    const b = imageData[i + 2];
    sum += 0.299 * r + 0.587 * g + 0.114 * b;
    count += 1;
  }

  return count ? sum / count : 0;
};

const getBlurScoreFromCanvas = (canvas, ctx) => {
  const width = Math.min(160, canvas.width);
  const height = Math.min(120, canvas.height);
  if (width < 8 || height < 8) return 100;

  const imageData = ctx.getImageData(0, 0, width, height).data;
  let diff = 0;
  let count = 0;
  const grayAt = (idx) => (
    0.299 * imageData[idx] + 0.587 * imageData[idx + 1] + 0.114 * imageData[idx + 2]
  );

  for (let y = 1; y < height; y += 2) {
    for (let x = 1; x < width; x += 2) {
      const idx = (y * width + x) * 4;
      const leftIdx = (y * width + x - 1) * 4;
      const topIdx = ((y - 1) * width + x) * 4;
      diff += Math.abs(grayAt(idx) - grayAt(leftIdx)) + Math.abs(grayAt(idx) - grayAt(topIdx));
      count += 2;
    }
  }

  return count ? diff / count : 100;
};

const getLightingQuality = (brightness) => {
  if (brightness < POOR_BRIGHTNESS_LOW || brightness > POOR_BRIGHTNESS_HIGH) return 'poor';
  if (brightness >= GOOD_BRIGHTNESS_LOW && brightness <= GOOD_BRIGHTNESS_HIGH) return 'good';
  return 'medium';
};

const getDuration = (startedAt) => (
  startedAt ? Math.max(0, Math.round((Date.now() - startedAt) / 1000)) : 0
);

const countWhere = (items, predicate) => items.reduce((sum, item) => sum + (predicate(item) ? 1 : 0), 0);

const mostFrequent = (items, key, fallback) => {
  const counts = new Map();
  for (const item of items) {
    const value = item?.[key] ?? fallback;
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  let best = fallback;
  let bestCount = -1;
  for (const [value, count] of counts.entries()) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
};

const stabilizeFrame = (historyRef, frame) => {
  const history = [...historyRef.current, frame].slice(-SMOOTHING_WINDOW);
  historyRef.current = history;

  const facePresent = countWhere(history, (item) => item.facePresent) >= STABLE_FACE_MIN;
  const multipleFaces = countWhere(history, (item) => item.multipleFaces) >= 2;
  const cameraBlocked = countWhere(history, (item) => item.cameraBlocked) >= STABLE_ISSUE_MIN;
  const lookingAway = facePresent && countWhere(history, (item) => item.lookingAway) >= STABLE_ISSUE_MIN;
  const blurryFrame = countWhere(history, (item) => item.blurryFrame) >= STABLE_ISSUE_MIN;
  const unstableFrame = countWhere(history, (item) => item.unstableFrame) >= STABLE_ISSUE_MIN;

  const poorLightingCount = countWhere(history, (item) => item.lightingQuality === 'poor');
  const goodLightingCount = countWhere(history, (item) => item.lightingQuality === 'good');
  const lightingQuality = poorLightingCount >= STABLE_ISSUE_MIN
    ? 'poor'
    : goodLightingCount >= STABLE_FACE_MIN
      ? 'good'
      : 'medium';

  const distanceMode = mostFrequent(history.filter((item) => item.facePresent), 'distanceStatus', 'good');
  const distanceStatus = facePresent ? distanceMode : 'good';
  const faceCentered = facePresent && countWhere(history, (item) => item.faceCentered) >= STABLE_FACE_MIN;

  return {
    ...frame,
    facePresent,
    faceDetected: facePresent,
    personCount: multipleFaces ? 'multiple' : facePresent ? 1 : 0,
    multipleFaces,
    cameraBlocked,
    lookingAway,
    blurryFrame,
    unstableFrame,
    lightingQuality,
    lightingOk: lightingQuality !== 'poor',
    distanceStatus,
    distanceOk: distanceStatus === 'good',
    faceCentered,
    centered: faceCentered,
  };
};

export default function VisionMonitor({
  active = false,
  interviewId,
  candidateId = '',
  questionId = '',
  token = '',
  apiBase = '',
  roomStatus = 'waiting',
  videoRef,
  onStatusChange,
  showYoloPanel = true,
}) {
  const detectorRef = useRef(null);
  const canvasRef = useRef(null);
  const timerRef = useRef(null);
  const lastPrecheckPostRef = useRef(0);
  const absentStartedAtRef = useRef(0);
  const lookingAwayStartedAtRef = useRef(0);
  const previousFrameRef = useRef(null);
  const frameHistoryRef = useRef([]);
  const pendingSummaryRef = useRef(resetSummary());
  const [status, setStatus] = useState(initialStatus);
  const [ready, setReady] = useState(false);

  const isInterviewLive = useMemo(() => roomStatus === 'active' || roomStatus === 'ended', [roomStatus]);

  // YOLO vision hook for object detection
  const {
    yoloEnabled,
    yoloStatus,
    latestYoloSummary,
    yoloError,
  } = useYoloVision({
    active: active && showYoloPanel,
    interviewId,
    candidateId,
    questionId,
    token,
    apiBase,
    roomStatus,
    videoRef,
  });

  const postVisionUpdate = async ({ precheck, summaryDelta }) => {
    if (!interviewId || !token || (!precheck && !summaryDelta)) return;

    try {
      await fetch(`${apiBase}/api/call-rooms/${interviewId}/vision-monitoring`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          currentQuestionId: questionId,
          precheck,
          summaryDelta,
        }),
      });
    } catch (error) {
      console.warn('Vision monitoring update failed:', error);
    }
  };

  const flushSummary = () => {
    const delta = pendingSummaryRef.current;
    const hasAny = Object.values(delta).some((value) => Number(value) > 0);
    if (!hasAny) return;
    pendingSummaryRef.current = resetSummary();
    void postVisionUpdate({ summaryDelta: delta });
  };

  useEffect(() => {
    let cancelled = false;

    const setup = async () => {
      try {
        const filesetResolver = await FilesetResolver.forVisionTasks(
          'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm',
        );

        const detector = await FaceLandmarker.createFromOptions(filesetResolver, {
          baseOptions: {
            modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
            delegate: 'CPU',
          },
          runningMode: 'IMAGE',
          numFaces: 3,
          minFaceDetectionConfidence: 0.5,
          minFacePresenceConfidence: 0.5,
        });

        if (cancelled) {
          detector.close?.();
          return;
        }

        detectorRef.current = detector;
        setReady(true);
      } catch (error) {
        console.warn('Failed to initialize MediaPipe FaceLandmarker:', error);
        setReady(false);
        const nextStatus = {
          ...initialStatus,
          message: 'Camera monitoring unavailable',
        };
        setStatus(nextStatus);
        onStatusChange?.(nextStatus);
      }
    };

    setup();
    return () => {
      cancelled = true;
      detectorRef.current?.close?.();
      detectorRef.current = null;
    };
  }, [onStatusChange]);

  useEffect(() => {
    if (!active || !ready || !videoRef?.current) {
      const nextStatus = {
        ...status,
        message: active ? 'Preparing camera analysis...' : 'Camera monitoring inactive',
      };
      setStatus(nextStatus);
      onStatusChange?.(nextStatus);
      return undefined;
    }

    const analyze = () => {
      const video = videoRef.current;
      const detector = detectorRef.current;
      if (!video || !detector || video.readyState < 2) return;

      const canvas = canvasRef.current || document.createElement('canvas');
      canvasRef.current = canvas;

      const width = video.videoWidth || 640;
      const height = video.videoHeight || 480;
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return;
      ctx.drawImage(video, 0, 0, width, height);

      const brightness = getBrightnessFromCanvas(canvas, ctx);
      const lightingQuality = getLightingQuality(brightness);
      const blurScore = getBlurScoreFromCanvas(canvas, ctx);
      const blurryFrame = blurScore < BLUR_THRESHOLD;

      let detections = [];
      try {
        const result = detector.detect(canvas);
        detections = result?.faceLandmarks || [];
      } catch (err) {
        console.warn('FaceLandmarker detect error', err);
      }

      const facePresentRaw = detections.length > 0;
      const multipleFacesRaw = detections.length > 1;
      const cameraBlockedRaw = !facePresentRaw && brightness < 20;

      let rawStatus = {
        ...initialStatus,
        facePresent: facePresentRaw,
        faceDetected: facePresentRaw,
        personCount: multipleFacesRaw ? 'multiple' : detections.length,
        multipleFaces: multipleFacesRaw,
        lightingQuality,
        lightingOk: lightingQuality !== 'poor',
        brightness,
        blurryFrame,
        cameraBlocked: cameraBlockedRaw,
        message: facePresentRaw ? 'Camera OK' : 'Face not detected',
      };

      if (facePresentRaw) {
        const landmarks = detections[0];
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

        const faceWidth = maxX - minX;
        const faceHeight = maxY - minY;
        const centerX = minX + faceWidth / 2;
        const centerY = minY + faceHeight / 2;
        const centerOffsetX = Math.abs(centerX - 0.5);
        const centerOffsetY = Math.abs(centerY - 0.5);
        const faceCentered = centerOffsetX <= CENTER_TOLERANCE_X && centerOffsetY <= CENTER_TOLERANCE_Y;
        const faceRatio = Math.max(faceWidth, faceHeight);
        const distanceStatus = faceRatio < MIN_FACE_RATIO
          ? 'too_far'
          : faceRatio > MAX_FACE_RATIO
            ? 'too_close'
            : 'good';

        const leftEyeX = landmarks[33] && landmarks[133] ? (landmarks[33].x + landmarks[133].x) / 2 : centerX;
        const rightEyeX = landmarks[362] && landmarks[263] ? (landmarks[362].x + landmarks[263].x) / 2 : centerX;
        const eyeMidX = (leftEyeX + rightEyeX) / 2;
        const noseX = landmarks[1]?.x ?? centerX;
        const lookingAway = Math.abs(noseX - eyeMidX) > 0.055;

        const prev = previousFrameRef.current;
        const unstableFrame = !!prev && (
          Math.abs(prev.centerX - centerX) > 0.22 ||
          Math.abs(prev.centerY - centerY) > 0.22 ||
          Math.abs(prev.brightness - brightness) > 80
        );
        previousFrameRef.current = { centerX, centerY, brightness };

        rawStatus = {
          ...rawStatus,
          faceCentered,
          centered: faceCentered,
          distanceStatus,
          distanceOk: distanceStatus === 'good',
          lookingAway,
          candidateAbsentDurationSeconds: 0,
          faceRatio,
          centerOffsetX,
          centerOffsetY,
          unstableFrame,
        };
      }

      const now = Date.now();
      const nextStatus = stabilizeFrame(frameHistoryRef, rawStatus);

      pendingSummaryRef.current.totalChecks += 1;
      if (nextStatus.facePresent) pendingSummaryRef.current.faceDetectedChecks += 1;
      else pendingSummaryRef.current.noFaceChecks += 1;
      if (nextStatus.multipleFaces) pendingSummaryRef.current.multipleFacesChecks += 1;
      if (nextStatus.lightingQuality === 'poor') pendingSummaryRef.current.lightingIssueChecks += 1;
      if (nextStatus.facePresent && !nextStatus.faceCentered) pendingSummaryRef.current.positionIssueChecks += 1;
      if (nextStatus.facePresent && nextStatus.distanceStatus !== 'good') pendingSummaryRef.current.distanceIssueChecks += 1;

      if (!nextStatus.facePresent) {
        if (!absentStartedAtRef.current) absentStartedAtRef.current = now;
        lookingAwayStartedAtRef.current = 0;
        nextStatus.candidateAbsentDurationSeconds = getDuration(absentStartedAtRef.current);
      } else {
        absentStartedAtRef.current = 0;
        nextStatus.candidateAbsentDurationSeconds = 0;
        if (nextStatus.lookingAway) {
          if (!lookingAwayStartedAtRef.current) lookingAwayStartedAtRef.current = now;
        } else {
          lookingAwayStartedAtRef.current = 0;
        }
        nextStatus.lookingAwayDurationSeconds = getDuration(lookingAwayStartedAtRef.current);
      }

      nextStatus.message = !nextStatus.facePresent
        ? nextStatus.cameraBlocked ? 'Camera needs attention' : 'Face not detected'
        : nextStatus.lookingAway
          ? 'Please look toward the screen'
          : !nextStatus.faceCentered || nextStatus.distanceStatus !== 'good'
            ? 'Please adjust your position'
            : nextStatus.lightingQuality === 'poor'
              ? 'Lighting needs attention'
              : 'Camera OK';

      setStatus(nextStatus);
      onStatusChange?.(nextStatus);

      if (Date.now() - lastPrecheckPostRef.current >= PRECHECK_POST_INTERVAL_MS) {
        lastPrecheckPostRef.current = Date.now();
        void postVisionUpdate({
          precheck: {
            cameraAvailable: true,
            faceDetected: nextStatus.facePresent,
            faceCentered: nextStatus.faceCentered,
            lightingOk: nextStatus.lightingQuality !== 'poor',
            multipleFacesDetected: nextStatus.personCount === 'multiple',
          },
        });
      }

      if (isInterviewLive && pendingSummaryRef.current.totalChecks >= 10) {
        flushSummary();
      }
    };

    timerRef.current = setInterval(analyze, ANALYSIS_INTERVAL_MS);
    analyze();

    return () => {
      clearInterval(timerRef.current);
      timerRef.current = null;
      flushSummary();
    };
  }, [active, ready, videoRef, onStatusChange, apiBase, interviewId, token, questionId, isInterviewLive]);

  const checks = [
    { label: 'Camera', value: active && !status.cameraBlocked ? 'OK' : 'Issue', ok: active && !status.cameraBlocked },
    { label: 'Face', value: status.facePresent ? 'Detected' : 'Not detected', ok: status.facePresent },
    { label: 'Lighting', value: status.lightingQuality === 'poor' ? 'Poor' : status.lightingQuality === 'good' ? 'Good' : 'Medium', ok: status.lightingQuality !== 'poor' },
    { label: 'Position', value: status.faceCentered && status.distanceStatus === 'good' ? 'Good' : 'Adjust', ok: status.faceCentered && status.distanceStatus === 'good' },
    { label: 'Monitoring', value: active ? 'Active' : 'Off', ok: active },
  ];

  // YOLO status display values (candidate-facing, non-aggressive)
  const getYoloPersonStatus = () => {
    if (!yoloEnabled || yoloStatus !== 'available') return { value: 'Unknown', ok: true };
    if (!latestYoloSummary) return { value: 'Checking...', ok: true };
    const count = latestYoloSummary.personCount;
    if (count === null || count === undefined) return { value: 'Unknown', ok: true };
    if (count === 0) return { value: 'No person', ok: false };
    if (count === 1) return { value: '1 person', ok: true };
    return { value: `${count} people`, ok: false };
  };

  const getYoloObjectStatus = () => {
    if (!yoloEnabled || yoloStatus !== 'available' || !latestYoloSummary) {
      return { value: 'Monitoring...', ok: true };
    }
    if (latestYoloSummary.suspiciousObjectDetected) {
      return { value: 'Needs review', ok: false };
    }
    return { value: 'No objects', ok: true };
  };

  const yoloPerson = getYoloPersonStatus();
  const yoloObjects = getYoloObjectStatus();

  return (
    <div className="vm-card">
      <div className="vm-card__header">
        <span className="vm-card__title">Interview Integrity Assistant</span>
        <span className={`vm-pill ${active ? 'vm-pill--live' : ''}`}>
          {active ? 'Active' : 'Off'}
        </span>
      </div>
      <div className="vm-card__grid">
        {checks.map((item) => (
          <div key={item.label} className={`vm-check ${item.ok ? 'vm-check--ok' : 'vm-check--warn'}`}>
            <span className="vm-check__label">{item.label}</span>
            <span className="vm-check__value">{item.value}</span>
          </div>
        ))}
      </div>
      
      {/* YOLO Object Monitor Panel - Candidate facing */}
      {showYoloPanel && (
        <div className="vm-yolo-section">
          <div className="vm-yolo-header">
            <span className="vm-yolo-title">Object Monitor</span>
            <span className={`vm-yolo-status ${yoloStatus === 'available' ? 'vm-yolo-status--ok' : yoloStatus === 'unavailable' ? 'vm-yolo-status--warn' : ''}`}>
              {yoloStatus === 'available' ? 'Active' : yoloStatus === 'unavailable' ? 'Offline' : 'Starting...'}
            </span>
          </div>
          <div className="vm-yolo-grid">
            <div className={`vm-check ${yoloPerson.ok ? 'vm-check--ok' : 'vm-check--warn'}`}>
              <span className="vm-check__label">People</span>
              <span className="vm-check__value">{yoloPerson.value}</span>
            </div>
            <div className={`vm-check ${yoloObjects.ok ? 'vm-check--ok' : 'vm-check--warn'}`}>
              <span className="vm-check__label">Objects</span>
              <span className="vm-check__value">{yoloObjects.value}</span>
            </div>
          </div>
        </div>
      )}
      
      <div className={`vm-message ${status.facePresent && status.faceCentered && status.lightingQuality !== 'poor' && status.distanceStatus === 'good' ? 'vm-message--ok' : 'vm-message--warn'}`}>
        {status.message}
      </div>
    </div>
  );
}
