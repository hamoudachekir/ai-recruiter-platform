import { useEffect, useRef, useCallback } from 'react';
import './RealFaceAvatar.css';

// Default: professional AI-generated portrait (no real person, no attribution needed).
// Override via VITE_INTERVIEWER_FACE_URL in Frontend/.env
const FACE_URL =
  import.meta.env.VITE_INTERVIEWER_FACE_URL ||
  'https://randomuser.me/api/portraits/women/65.jpg';

// Split line: fraction of image height where the jaw splits open.
// ~0.67 = just above the upper lip in a typical close-up portrait.
const SPLIT_FRAC   = Number(import.meta.env.VITE_AVATAR_SPLIT_FRAC   || 0.67);
// Max pixels the lower-jaw half shifts downward at full amplitude
const MAX_JAW_PX   = Number(import.meta.env.VITE_AVATAR_MAX_JAW_PX   || 16);
// Mouth opening ellipse width relative to canvas width
const MOUTH_W_FRAC = Number(import.meta.env.VITE_AVATAR_MOUTH_W_FRAC || 0.38);

export default function RealFaceAvatar() {
  const canvasRef  = useRef(null);
  const imgRef     = useRef(new Image());
  const readyRef   = useRef(false);
  const rafRef     = useRef(null);

  // Web Audio analysis
  const audioCtxRef    = useRef(null);
  const analyserRef    = useRef(null);
  const srcNodeRef     = useRef(null);
  const dataRef        = useRef(null);
  const lastAudioElRef = useRef(null);

  // Animation state
  const isSpeakingRef = useRef(false);
  const jawRef        = useRef(0);   // smoothed 0-1
  const breathRef     = useRef(0);
  const blinkRef      = useRef({ timer: 0, phase: 0, active: false });

  /* ── Audio ─────────────────────────────────────────────────── */

  const connectAudio = useCallback((audioEl) => {
    if (!audioEl || audioEl === lastAudioElRef.current) return;
    lastAudioElRef.current = audioEl;
    try {
      if (!audioCtxRef.current || audioCtxRef.current.state === 'closed') {
        audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
      }
      const actx = audioCtxRef.current;
      if (actx.state === 'suspended') actx.resume().catch(() => {});

      try { srcNodeRef.current?.disconnect(); } catch {}

      const analyser = actx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.65;

      const src = actx.createMediaElementSource(audioEl);
      src.connect(analyser);
      analyser.connect(actx.destination);

      analyserRef.current = analyser;
      srcNodeRef.current  = src;
      dataRef.current     = new Uint8Array(analyser.frequencyBinCount);
    } catch (e) {
      console.warn('[RealFaceAvatar] audio connect:', e.message);
    }
  }, []);

  const getAmplitude = useCallback(() => {
    if (!analyserRef.current || !dataRef.current || !isSpeakingRef.current) return 0;
    analyserRef.current.getByteFrequencyData(dataRef.current);
    // Speech frequencies: ~300–3400 Hz (bins 2-20 at 44100 Hz / fftSize 256)
    let s = 0;
    for (let i = 2; i <= 20; i++) s += dataRef.current[i];
    return (s / 19) / 255;
  }, []);

  /* ── Draw loop ──────────────────────────────────────────────── */

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const img    = imgRef.current;
    if (!canvas || !readyRef.current) {
      rafRef.current = requestAnimationFrame(draw);
      return;
    }

    const c  = canvas.getContext('2d');
    const cw = canvas.width;
    const ch = canvas.height;
    const iw = img.naturalWidth  || cw;
    const ih = img.naturalHeight || ch;

    // Subtle breathing bob
    breathRef.current += 0.018;
    const breathY = Math.sin(breathRef.current) * 1.2;

    // Blink every 3-5 seconds
    const bl = blinkRef.current;
    bl.timer++;
    if (!bl.active && bl.timer > 180 + Math.random() * 120) {
      bl.active = true; bl.phase = 0; bl.timer = 0;
    }
    let blinkScale = 0;
    if (bl.active) {
      bl.phase += 0.15;
      blinkScale = Math.sin(bl.phase * Math.PI);
      if (bl.phase >= 1) bl.active = false;
    }

    // Jaw openness (lerp toward audio amplitude target)
    const amp    = getAmplitude();
    const target = isSpeakingRef.current ? amp : 0;
    jawRef.current += (target - jawRef.current) * (isSpeakingRef.current ? 0.3 : 0.12);
    const jawPx  = jawRef.current * MAX_JAW_PX;

    c.clearRect(0, 0, cw, ch);

    const splitY    = ch * SPLIT_FRAC + breathY;
    const srcSplitY = ih * SPLIT_FRAC;

    // ── Top half: forehead → upper lip (static except breath bob) ──
    c.drawImage(img, 0, 0, iw, srcSplitY, 0, breathY, cw, splitY - breathY);

    // ── Mouth gap when jaw is open ──
    if (jawPx > 0.5) {
      const mx = cw * 0.5;
      const mw = cw * MOUTH_W_FRAC;

      // Dark mouth interior gradient
      const grd = c.createLinearGradient(0, splitY, 0, splitY + jawPx);
      grd.addColorStop(0, 'rgba(20, 6, 6, 0.97)');
      grd.addColorStop(1, 'rgba(10, 3, 3, 0.99)');

      c.save();
      c.beginPath();
      c.ellipse(mx, splitY + jawPx * 0.5, mw / 2, jawPx / 2 + 0.5, 0, 0, Math.PI * 2);
      c.fillStyle = grd;
      c.fill();

      // Upper teeth row
      if (jawPx > 3) {
        c.beginPath();
        c.ellipse(mx, splitY + 2, mw * 0.40, Math.min(jawPx * 0.28, 6), 0, Math.PI, Math.PI * 2);
        c.fillStyle = 'rgba(242, 236, 224, 0.93)';
        c.fill();
      }
      // Lower teeth row
      if (jawPx > 8) {
        c.beginPath();
        c.ellipse(mx, splitY + jawPx - 2, mw * 0.32, Math.min(jawPx * 0.18, 5), 0, 0, Math.PI);
        c.fillStyle = 'rgba(234, 228, 216, 0.86)';
        c.fill();
      }
      c.restore();
    }

    // ── Bottom half: lower lip → chin (shifted down by jawPx) ──
    const dstBottom = ch - splitY - jawPx;
    if (dstBottom > 0) {
      c.drawImage(img, 0, srcSplitY, iw, ih - srcSplitY, 0, splitY + jawPx, cw, dstBottom);
    }

    // ── Eyelid blink overlay ──
    if (blinkScale > 0.05) {
      const eyeY  = ch * 0.375 + breathY;
      const eyeH  = ch * 0.022 * blinkScale * 2.2;
      const eyeLX = cw * 0.285;
      const eyeRX = cw * 0.655;
      const eyeW  = cw * 0.155;
      c.save();
      // Approximate skin tone lid — blends well on most portraits
      c.fillStyle = 'rgba(185, 148, 112, 0.93)';
      c.beginPath(); c.ellipse(eyeLX + eyeW / 2, eyeY, eyeW / 2, eyeH, 0, 0, Math.PI * 2); c.fill();
      c.beginPath(); c.ellipse(eyeRX + eyeW / 2, eyeY, eyeW / 2, eyeH, 0, 0, Math.PI * 2); c.fill();
      c.restore();
    }

    rafRef.current = requestAnimationFrame(draw);
  }, [getAmplitude]);

  /* ── Lifecycle ──────────────────────────────────────────────── */

  // Load face image
  useEffect(() => {
    const img = imgRef.current;
    img.crossOrigin = 'anonymous';
    img.onload  = () => { readyRef.current = true; };
    img.onerror = () => console.warn('[RealFaceAvatar] failed to load face image:', FACE_URL);
    img.src = FACE_URL;
  }, []);

  // Start render loop
  useEffect(() => {
    rafRef.current = requestAnimationFrame(draw);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      try { audioCtxRef.current?.close(); } catch {}
    };
  }, [draw]);

  // Listen for agent-speech events dispatched by CallRoomActive
  useEffect(() => {
    const onSpeech = (ev) => {
      const speaking = !!ev.detail?.speaking;
      isSpeakingRef.current = speaking;
      if (speaking) {
        // Grab the audio element exposed by playAgentAudioBlob
        const el = window.__agentAudioEl;
        if (el) connectAudio(el);
      }
    };
    window.addEventListener('agent-speech', onSpeech);
    return () => window.removeEventListener('agent-speech', onSpeech);
  }, [connectAudio]);

  return (
    <div className="rfa-card">
      <canvas ref={canvasRef} width={360} height={450} className="rfa-canvas" />
      <div className="rfa-label">
        <span className="rfa-dot" />
        AI Interviewer
      </div>
    </div>
  );
}
