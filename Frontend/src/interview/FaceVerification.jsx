import { useCallback, useEffect, useRef, useState } from 'react';
import './FaceVerification.css';

const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001';
const TARGET_FRAMES = 3;
const FRAME_INTERVAL_MS = 450;
const GOOD_FACE_START_DELAY_MS = 150;
const VERIFY_TIMEOUT_MS = Number(import.meta.env.VITE_FACE_VERIFY_TIMEOUT_MS || 5000);
const RESULT_HOLD_MS = 650;
const MAX_RETRIES = 0;
const RETRY_DELAY_MS = 900;
const LIVENESS_DURATION_MS = 1600;
const LIVENESS_SAMPLE_MS = 220;
const LIVENESS_MIN_DELTA = Number(import.meta.env.VITE_FACE_VERIFY_LIVENESS_MIN_DELTA || 3.5);

const LIVENESS_CHALLENGES = [
  'Turn your head slightly left',
  'Turn your head slightly right',
  'Move closer, then back',
];

const LANDMARKS = [
  { id: 'eye-l',   cx: 36, cy: 40 },
  { id: 'eye-r',   cx: 64, cy: 40 },
  { id: 'nose',    cx: 50, cy: 56 },
  { id: 'mouth-l', cx: 38, cy: 68 },
  { id: 'mouth-r', cx: 62, cy: 68 },
  { id: 'chin',    cx: 50, cy: 76 },
];

function captureFrame(videoEl, quality = 0.75) {
  if (!videoEl || !videoEl.videoWidth || !videoEl.videoHeight) return null;
  const MAX_WIDTH = 360;
  const scale = Math.min(1, MAX_WIDTH / videoEl.videoWidth);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(videoEl.videoWidth * scale);
  canvas.height = Math.round(videoEl.videoHeight * scale);
  canvas.getContext('2d').drawImage(videoEl, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', quality);
}

function captureMotionSample(videoEl) {
  if (!videoEl || !videoEl.videoWidth || !videoEl.videoHeight) return null;
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const sourceSize = Math.min(videoEl.videoWidth, videoEl.videoHeight) * 0.55;
  const sx = (videoEl.videoWidth - sourceSize) / 2;
  const sy = (videoEl.videoHeight - sourceSize) / 2;
  ctx.drawImage(videoEl, sx, sy, sourceSize, sourceSize, 0, 0, size, size);
  const data = ctx.getImageData(0, 0, size, size).data;
  const gray = new Uint8Array(size * size);
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    gray[j] = Math.round((data[i] + data[i + 1] + data[i + 2]) / 3);
  }
  return gray;
}

function meanAbsDelta(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let total = 0;
  for (let i = 0; i < a.length; i++) total += Math.abs(a[i] - b[i]);
  return total / a.length;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function messageForStatus(status, fallback = '') {
  if (status === 'not_enrolled') return 'Please upload a clear profile photo before starting the interview.';
  if (status === 'uncertain' || status === 'low_quality') return 'We could not verify your face clearly. Please center your face and try again.';
  if (status === 'not_matched') return 'Your face does not match the profile photo. Access to the interview is blocked.';
  if (status === 'multiple_faces') return 'Only the candidate should be visible. Please remove other faces from the camera.';
  if (status === 'no_face') return 'No face detected. Please center your face and try again.';
  if (status === 'liveness_failed') return 'Liveness check failed. Please use your real camera.';
  if (status === 'failed') return 'Face verification failed. Please retry or contact the recruiter.';
  return fallback || 'Face verification failed.';
}

export default function FaceVerification({ roomId, webcamRef, visionStatus, token, onVerified }) {
  const [phase, setPhase]               = useState('waiting');
  const [message, setMessage]           = useState('Position face in frame');
  const [subMessage, setSubMessage]     = useState('');
  const [resultStatus, setResultStatus] = useState(null);
  const [retryCount, setRetryCount]     = useState(0);
  const [retryable, setRetryable]       = useState(true);
  const [captureCount, setCaptureCount] = useState(0);
  const [activeDots, setActiveDots]     = useState([]);
  const [scanPct, setScanPct]           = useState(0);
  const [livenessChallenge, setLivenessChallenge] = useState('');

  const captureTimer  = useRef(null);
  const retryTimer    = useRef(null);
  const progressTimer = useRef(null);
  const dotTimer      = useRef(null);
  const sentRef       = useRef(false);
  const livenessRunRef = useRef(0);

  const clearTimers = () => {
    livenessRunRef.current += 1;
    [captureTimer, retryTimer, progressTimer, dotTimer].forEach(r => {
      if (r.current) { clearInterval(r.current); clearTimeout(r.current); r.current = null; }
    });
  };

  useEffect(() => {
    if (phase === 'liveness' || phase === 'capturing' || phase === 'sending') {
      setActiveDots([]);
      let i = 0;
      dotTimer.current = setInterval(() => {
        i++;
        setActiveDots(LANDMARKS.slice(0, i));
        if (i >= LANDMARKS.length) { clearInterval(dotTimer.current); dotTimer.current = null; }
      }, 260);
    } else if (phase === 'result' && resultStatus === 'matched') {
      setActiveDots(LANDMARKS);
    } else if (phase === 'waiting') {
      setActiveDots([]);
    }
    return () => { if (dotTimer.current) { clearInterval(dotTimer.current); dotTimer.current = null; } };
  }, [phase, resultStatus]);

  useEffect(() => {
    if (phase === 'sending') {
      setScanPct(0);
      let p = 0;
      progressTimer.current = setInterval(() => {
        p = Math.min(p + (Math.random() * 9 + 2), 91);
        setScanPct(Math.round(p));
      }, 180);
      return () => clearInterval(progressTimer.current);
    }
    if (phase === 'result') {
      setScanPct(resultStatus === 'matched' ? 100 : 0);
    }
    return undefined;
  }, [phase, resultStatus]);

  const isGoodCondition = useCallback(() => {
    if (!visionStatus) return false;
    if (!visionStatus.facePresent) return false;
    if (visionStatus.multipleFaces) return false;
    if (visionStatus.lightingQuality === 'poor') return false;
    return true;
  }, [visionStatus]);

  const startCapture = useCallback((liveness = {}) => {
    if (sentRef.current) return;
    const frames = [];
    let cancelled = false;
    setCaptureCount(0);
    setRetryable(true);
    setPhase('capturing');
    setMessage('CHECKING FACE');
    setSubMessage('Quick scan...');

    const captureOne = () => {
      const video = webcamRef?.current;
      if (!video) return;
      if (!isGoodCondition()) {
        cancelled = true;
        clearTimers();
        setPhase('waiting');
        setMessage('Face lost');
        setSubMessage('Reposition and try again');
        return;
      }
      const frame = captureFrame(video, 0.64);
      if (!frame) return;
      frames.push(frame);
      const count = frames.length;
      setCaptureCount(count);
      if (count >= TARGET_FRAMES) {
        clearInterval(captureTimer.current);
        captureTimer.current = null;
        sendFramesRef.current(frames, liveness);
      }
    };

    captureOne();
    if (!cancelled && frames.length < TARGET_FRAMES) {
      captureTimer.current = setInterval(captureOne, FRAME_INTERVAL_MS);
    }
  }, [webcamRef, isGoodCondition]);

  const startLiveness = useCallback(async () => {
    if (sentRef.current) return;
    const video = webcamRef?.current;
    if (!video || !isGoodCondition()) return;

    const runId = Date.now();
    livenessRunRef.current = runId;
    const challenge = LIVENESS_CHALLENGES[Math.floor(Math.random() * LIVENESS_CHALLENGES.length)];
    setLivenessChallenge(challenge);
    setRetryable(true);
    setPhase('liveness');
    setMessage('LIVENESS CHECK');
    setSubMessage(challenge);
    setScanPct(0);

    const baseline = captureMotionSample(video);
    let maxDelta = 0;
    const sampleCount = Math.max(2, Math.floor(LIVENESS_DURATION_MS / LIVENESS_SAMPLE_MS));

    for (let i = 0; i < sampleCount; i++) {
      await wait(LIVENESS_SAMPLE_MS);
      if (livenessRunRef.current !== runId) return;
      if (!isGoodCondition()) {
        setPhase('waiting');
        setMessage('Face lost');
        setSubMessage('Reposition and try again');
        return;
      }
      const sample = captureMotionSample(video);
      maxDelta = Math.max(maxDelta, meanAbsDelta(baseline, sample));
      setScanPct(Math.min(90, Math.round(((i + 1) / sampleCount) * 90)));
    }

    if (livenessRunRef.current !== runId) return;

    if (maxDelta < LIVENESS_MIN_DELTA) {
      setPhase('result');
      setResultStatus('liveness_failed');
      setRetryable(true);
      setMessage('LIVENESS FAILED');
      setSubMessage(messageForStatus('liveness_failed'));
      return;
    }

    startCapture({
      passed: true,
      challenge,
      score: maxDelta,
    });
  }, [webcamRef, isGoodCondition, startCapture]);

  const sendFramesRef = useRef(null);

  const sendFrames = useCallback(async (frames, liveness = {}) => {
    if (sentRef.current) return;
    sentRef.current = true;
    setPhase('sending');
    setMessage('ANALYZING');
    setSubMessage('Verifying identity...');

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);

    try {
      const resp = await fetch(`${API_BASE}/api/call-rooms/${roomId}/face-verify/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          frames,
          livenessPassed: liveness.passed === true,
          livenessChallenge: liveness.challenge || livenessChallenge,
          livenessScore: liveness.score || 0,
        }),
        signal: controller.signal,
      });
      const data = await resp.json().catch(() => ({}));
      sentRef.current = false;
      clearTimeout(timeoutId);

      if (resp.ok && data?.allowInterview === true && data?.status === 'matched') {
        setRetryable(false);
        setScanPct(100);
        setPhase('result');
        setResultStatus('matched');
        setMessage('VERIFIED');
        setSubMessage('Face verified. Starting interview...');
        setTimeout(() => onVerified?.('matched'), RESULT_HOLD_MS);
        return;
      }

      const nextStatus = data.status || 'failed';
      setPhase('result');
      setResultStatus(nextStatus);
      setRetryable(Boolean(data.retryable));
      setMessage(
        nextStatus === 'not_matched'
          ? 'ACCESS REFUSED'
          : nextStatus === 'liveness_failed'
            ? 'LIVENESS FAILED'
            : nextStatus === 'uncertain'
            ? 'FACE UNCLEAR'
            : 'CHECK FAILED'
      );
      setSubMessage(data.message || messageForStatus(nextStatus));

      if (data.retryable && retryCount < MAX_RETRIES) {
        retryTimer.current = setTimeout(() => {
          setRetryCount(r => r + 1);
          sentRef.current = false;
          startCapture();
        }, RETRY_DELAY_MS);
      }
    } catch (err) {
      sentRef.current = false;
      clearTimeout(timeoutId);
      setRetryable(true);
      setScanPct(0);
      setPhase('result');
      setResultStatus('failed');
      setMessage('CHECK FAILED');
      setSubMessage('Face verification failed. Please retry or contact the recruiter.');
    }
  }, [roomId, token, retryCount, startCapture, onVerified, livenessChallenge]);

  sendFramesRef.current = sendFrames;

  useEffect(() => {
    if (phase === 'waiting' && isGoodCondition() && !sentRef.current) {
      const t = setTimeout(() => { if (isGoodCondition()) startLiveness(); }, GOOD_FACE_START_DELAY_MS);
      return () => clearTimeout(t);
    }
  }, [phase, isGoodCondition, startLiveness]);

  useEffect(() => {
    if (phase !== 'waiting') return;
    if (!visionStatus)                           { setMessage('Starting camera...'); setSubMessage(''); return; }
    if (visionStatus.multipleFaces)              { setMessage('Multiple faces'); setSubMessage('Only you should be visible'); return; }
    if (!visionStatus.facePresent)               { setMessage('No face'); setSubMessage('Look at the camera'); return; }
    if (visionStatus.lightingQuality === 'poor') { setMessage('Poor lighting'); setSubMessage('Move to brighter area'); return; }
    if (visionStatus.faceCentered === false)      { setMessage('Center face'); setSubMessage('Move into the frame'); return; }
    if (visionStatus.distanceStatus && visionStatus.distanceStatus !== 'good') {
      setMessage(visionStatus.distanceStatus === 'too_close' ? 'Move back' : 'Move closer');
      setSubMessage('Keep your face clearly visible');
      return;
    }
    setMessage('FACE DETECTED');
    setSubMessage('Quick scan starting...');
  }, [phase, visionStatus]);

  useEffect(() => () => clearTimers(), []);

  const isRunning = phase === 'liveness' || phase === 'capturing' || phase === 'sending';
  const isResult  = phase === 'result';

  const colorKey = (() => {
    if (isResult) {
      if (resultStatus === 'matched') return 'success';
      if (resultStatus === 'not_matched') return 'error';
      return 'warn';
    }
    return isRunning ? 'active' : 'idle';
  })();

  const CIRC = 276.46;
  const ringOffset = isRunning || isResult
    ? CIRC - (scanPct / 100) * CIRC
    : CIRC;

  const meshActive = activeDots.length === LANDMARKS.length;

  return (
    <div className="fv-overlay">

      {/* ── Full-frame scan SVG — overlaid directly on video ── */}
      <svg className="fv-fullsvg" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice">

        {/* Outer progress ring */}
        <circle className="fv-ring-track" cx="50" cy="50" r="44" />
        <circle
          className={`fv-ring-fill fv-ring-fill--${colorKey}`}
          cx="50" cy="50" r="44"
          strokeDasharray={CIRC}
          strokeDashoffset={ringOffset}
        />

        {/* Face oval in face-coordinate space (viewBox 0 0 100 110 mapped to 100 100) */}
        <ellipse
          className={`fv-oval fv-oval--${colorKey}`}
          cx="50" cy="52" rx="22" ry="28"
        />

        {/* Connection mesh */}
        {meshActive && (
          <g className={`fv-mesh fv-mesh--${colorKey}`}>
            <line x1="37" y1="42" x2="63" y2="42" />
            <line x1="37" y1="42" x2="50" y2="54" />
            <line x1="63" y1="42" x2="50" y2="54" />
            <line x1="50" y1="54" x2="39" y2="64" />
            <line x1="50" y1="54" x2="61" y2="64" />
            <line x1="39" y1="64" x2="61" y2="64" />
            <line x1="50" y1="64" x2="50" y2="71" />
          </g>
        )}

        {/* Landmark dots */}
        {activeDots.map((pt, i) => (
          <circle
            key={pt.id}
            className={`fv-dot fv-dot--${colorKey}`}
            cx={pt.cx * 0.68 + 16} cy={pt.cy * 0.72 + 11} r="1.8"
            style={{ animationDelay: `${i * 0.06}s` }}
          />
        ))}

        {/* Result glyph */}
        {isResult && resultStatus === 'matched' && (
          <text className="fv-glyph fv-glyph--success" x="50" y="57" textAnchor="middle">✓</text>
        )}
        {isResult && resultStatus === 'not_matched' && (
          <text className="fv-glyph fv-glyph--error" x="50" y="57" textAnchor="middle">✕</text>
        )}
      </svg>

      {/* ── Corner brackets ── */}
      {['tl','tr','bl','br'].map(pos => (
        <span key={pos} className={`fv-corner fv-corner--${pos} fv-corner--${colorKey}`} />
      ))}

      {/* ── Scan bar — sweeps through while active ── */}
      {isRunning && <div className="fv-scanbar" />}

      {/* ── Frame capture pips ── */}
      {phase === 'capturing' && (
        <div className="fv-frames">
          {Array.from({ length: TARGET_FRAMES }).map((_, i) => (
            <span key={i} className={`fv-fdot ${i < captureCount ? 'fv-fdot--on' : ''}`} />
          ))}
        </div>
      )}

      {/* ── Status badge (during scan / live progress) ── */}
      {!isResult && (
        <div className={`fv-badge fv-badge--${colorKey}`}>
          <p className={`fv-smain fv-smain--${colorKey}`}>{message}</p>
          {subMessage && <p className="fv-ssub">{subMessage}</p>}
          {phase === 'sending' && (
            <div className="fv-pbar">
              <div className={`fv-pfill fv-pfill--${colorKey}`} style={{ width: `${scanPct}%` }} />
            </div>
          )}
        </div>
      )}

      {/* ── Result popup — stays in the call room, doesn't navigate away ── */}
      {isResult && (
        <div className={`fv-popup fv-popup--${colorKey}`} role="dialog" aria-live="polite">
          <div className="fv-popup-icon">
            {resultStatus === 'matched' && '✓'}
            {resultStatus === 'not_matched' && '✕'}
            {resultStatus !== 'matched' && resultStatus !== 'not_matched' && '!'}
          </div>
          <h3 className={`fv-popup-title fv-popup-title--${colorKey}`}>
            {resultStatus === 'matched' && 'Identity Verified'}
            {resultStatus === 'not_matched' && 'Identity Refused'}
            {resultStatus !== 'matched' && resultStatus !== 'not_matched' && 'Verification Incomplete'}
          </h3>
          <p className="fv-popup-msg">
            {resultStatus === 'matched' && 'Face matches the profile photo. Starting the interview...'}
            {resultStatus === 'not_matched' && (subMessage || messageForStatus('not_matched'))}
            {resultStatus !== 'matched' && resultStatus !== 'not_matched' && (subMessage || messageForStatus(resultStatus))}
          </p>
          {(phase === 'sending' || resultStatus === 'matched') && (
            <div className="fv-pbar fv-pbar--popup">
              <div className={`fv-pfill fv-pfill--${colorKey}`} style={{ width: `${scanPct}%` }} />
            </div>
          )}

          {/* Buttons only on non-success results — candidate stays in the call room */}
          {resultStatus !== 'matched' && (
            <div className="fv-actions fv-actions--popup">
              {retryable && (
                <button className="fv-btn fv-btn--retry" onClick={() => {
                  clearTimers();
                  setRetryCount(0);
                  setRetryable(true);
                  sentRef.current = false;
                  setPhase('waiting');
                  setResultStatus(null);
                  setActiveDots([]);
                  setScanPct(0);
                  setLivenessChallenge('');
                }}>
                  Retry scan
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
