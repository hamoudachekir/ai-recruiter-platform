import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { ALL_VISEMES, textToVisemeSchedule, activeVisemeAt } from './lipsyncEn';

// A Ready Player Me half-body avatar with ARKit blendshapes (so jawOpen,
// mouthSmile, eyeBlink, viseme_* all exist as morph targets). Override via
// VITE_INTERVIEW_AVATAR_URL in your .env if you create your own at
// https://readyplayer.me/avatar.
const DEFAULT_AVATAR_URL =
  import.meta.env.VITE_INTERVIEW_AVATAR_URL
  || 'https://models.readyplayer.me/64bfa15f0e72c63d7c3934a6.glb?morphTargets=ARKit&textureAtlas=1024';

// Backup mouth-open morphs we drive together with the active viseme,
// in case a particular avatar export is missing some viseme blendshapes.
// A small jawOpen contribution from open-vowel visemes still gives motion.
const FALLBACK_OPEN_MORPHS = ['jawOpen', 'mouthOpen'];
const OPEN_VOWEL_VISEMES = new Set(['viseme_aa', 'viseme_O', 'viseme_E', 'viseme_U', 'viseme_I']);
const BLINK_MORPH_NAMES = ['eyeBlinkLeft', 'eyeBlinkRight'];

/**
 * 3D talking-head avatar for the candidate's call room.
 *
 * Listens to the `agent-speech` window CustomEvent (fired by CallRoomActive
 * when the agent's TTS audio starts/ends) and drives ARKit viseme morph
 * targets timed against the audio duration — phoneme-style lip-sync rather
 * than amplitude flapping. Pure browser, no API key, no GPU server.
 *
 * Event shape:
 *   detail: { speaking: boolean, text?: string, durationMs?: number }
 *
 * On speaking=true with text+durationMs we precompute a viseme schedule
 * (text -> [{ v, weight, startMs, endMs }, ...]) and the render loop picks
 * the active viseme each frame, applying it via morphTargetInfluences.
 */
export default function InterviewAvatar() {
  const containerRef = useRef(null);
  const stateRef = useRef({
    renderer: null,
    scene: null,
    camera: null,
    avatarMeshes: [],
    isSpeaking: false,
    isThinking: false,
    rafId: 0,
    nextBlinkAt: 0,
    blinkPhase: 0,
    schedule: null,
    speechStartedAt: 0,
    speechEndAt: 0,
  });

  const [phase, setPhase] = useState('idle'); // 'idle' | 'thinking' | 'speaking'
  const [status, setStatus] = useState('Loading avatar…');
  const [loadFailed, setLoadFailed] = useState(false);

  // Set up Three.js scene once on mount.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;

    const scene = new THREE.Scene();
    scene.background = null;

    const width = container.clientWidth || 320;
    const height = container.clientHeight || 360;

    const camera = new THREE.PerspectiveCamera(30, width / height, 0.1, 100);
    camera.position.set(0, 1.55, 0.65);
    camera.lookAt(0, 1.55, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(renderer.domElement);

    scene.add(new THREE.AmbientLight(0xffffff, 0.85));
    const key = new THREE.DirectionalLight(0xffffff, 1.1);
    key.position.set(0.8, 1.6, 1.4);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xc7d7ff, 0.45);
    fill.position.set(-1.2, 1.0, 0.8);
    scene.add(fill);

    stateRef.current.scene = scene;
    stateRef.current.camera = camera;
    stateRef.current.renderer = renderer;

    const loader = new GLTFLoader();
    loader.load(
      DEFAULT_AVATAR_URL,
      (gltf) => {
        const root = gltf.scene;
        scene.add(root);

        const meshes = [];
        root.traverse((obj) => {
          if (obj.isMesh && obj.morphTargetDictionary && obj.morphTargetInfluences) {
            meshes.push(obj);
          }
        });
        stateRef.current.avatarMeshes = meshes;
        stateRef.current.nextBlinkAt = performance.now() + 2500 + Math.random() * 2500;
        setStatus('');
      },
      undefined,
      (error) => {
        console.error('InterviewAvatar: failed to load', DEFAULT_AVATAR_URL, error);
        setLoadFailed(true);
        setStatus('Avatar unavailable');
      },
    );

    // Animation loop.
    const tick = () => {
      stateRef.current.rafId = requestAnimationFrame(tick);
      const s = stateRef.current;
      if (!s.scene || !s.camera || !s.renderer) return;

      const now = performance.now();
      const t = now / 1000;

      // ── Lip-sync target ─────────────────────────────────────────────
      // If we have a schedule and we're inside its time window, find the
      // active viseme and shape the weight with a sin envelope so each
      // phoneme ramps in and back out instead of snapping.
      let activeViseme = null;
      let activeWeight = 0;
      let openVowelContribution = 0;

      if (s.schedule && s.isSpeaking) {
        const elapsed = now - s.speechStartedAt;
        const slot = activeVisemeAt(s.schedule, elapsed);
        if (slot) {
          // Sin envelope across the slot: 0 -> 1 -> 0 over its duration.
          // Slight bias (0.3) so consonants don't fully disappear before
          // the next phoneme starts — gives smoother coarticulation.
          const envelope = 0.3 + 0.7 * Math.sin(slot.progress * Math.PI);
          activeViseme = slot.v;
          activeWeight = slot.weight * envelope;
          if (OPEN_VOWEL_VISEMES.has(slot.v)) {
            openVowelContribution = activeWeight * 0.55;
          }
        }
      }

      // ── Blink ───────────────────────────────────────────────────────
      let blinkValue = 0;
      if (now >= s.nextBlinkAt) {
        s.blinkPhase = 1;
        s.nextBlinkAt = now + 2800 + Math.random() * 3200;
      }
      if (s.blinkPhase > 0) {
        s.blinkPhase = Math.max(0, s.blinkPhase - 0.16);
        blinkValue = s.blinkPhase < 0.5 ? s.blinkPhase * 2 : (1 - s.blinkPhase) * 2;
      }

      // ── Apply morphs ────────────────────────────────────────────────
      s.avatarMeshes.forEach((mesh) => {
        const dict = mesh.morphTargetDictionary;
        const inf = mesh.morphTargetInfluences;
        if (!dict || !inf) return;

        // For each known viseme target, drive toward 0 except the active
        // one which drives toward `activeWeight`. Smoothing factor 0.5
        // makes transitions snappy enough to read as distinct phonemes
        // but soft enough to avoid jitter.
        ALL_VISEMES.forEach((name) => {
          if (dict[name] === undefined) return;
          const idx = dict[name];
          const target = name === activeViseme ? activeWeight : 0;
          inf[idx] = inf[idx] + (target - inf[idx]) * 0.5;
        });

        // Some RPM exports drop one or two visemes — a small jawOpen
        // contribution from open-vowel sounds keeps mouth motion visible
        // even on those avatars.
        FALLBACK_OPEN_MORPHS.forEach((name) => {
          if (dict[name] === undefined) return;
          const idx = dict[name];
          const target = openVowelContribution;
          inf[idx] = inf[idx] + (target - inf[idx]) * 0.4;
        });

        BLINK_MORPH_NAMES.forEach((name) => {
          if (dict[name] !== undefined) {
            inf[dict[name]] = blinkValue;
          }
        });
      });

      // Subtle head sway so the avatar doesn't look frozen.
      s.scene.rotation.y = Math.sin(t * 0.4) * 0.04;

      s.renderer.render(s.scene, s.camera);
    };
    tick();

    const onResize = () => {
      const w = container.clientWidth || 320;
      const h = container.clientHeight || 360;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(container);

    return () => {
      cancelAnimationFrame(stateRef.current.rafId);
      ro.disconnect();
      renderer.dispose();
      if (renderer.domElement.parentNode) {
        renderer.domElement.parentNode.removeChild(renderer.domElement);
      }
      stateRef.current.scene = null;
      stateRef.current.camera = null;
      stateRef.current.renderer = null;
      stateRef.current.avatarMeshes = [];
    };
  }, []);

  // Drive lip-sync from `agent-speech` events. Payload shape:
  //   { speaking: true, text: 'Hello...', durationMs: 2400 }
  // When durationMs is missing we estimate from the text length so the
  // mouth still moves even if CallRoomActive emits without metadata.
  useEffect(() => {
    const onSpeech = (ev) => {
      const speaking = !!ev?.detail?.speaking;
      const text = String(ev?.detail?.text || '').trim();
      const reportedMs = Number(ev?.detail?.durationMs);
      const fallbackMs = Math.max(1500, text.length * 75);
      const durationMs = Number.isFinite(reportedMs) && reportedMs > 0 ? reportedMs : fallbackMs;

      const s = stateRef.current;
      s.isSpeaking = speaking;

      if (speaking && text) {
        s.schedule = textToVisemeSchedule(text, durationMs);
        s.speechStartedAt = performance.now();
        s.speechEndAt = s.speechStartedAt + durationMs;
      } else {
        s.schedule = null;
        s.speechStartedAt = 0;
        s.speechEndAt = 0;
      }

      setPhase((prev) => {
        if (speaking) return 'speaking';
        if (prev === 'speaking') return 'idle';
        return prev;
      });
    };

    const onThinking = (ev) => {
      const thinking = !!ev?.detail?.thinking;
      stateRef.current.isThinking = thinking;
      setPhase((prev) => {
        if (thinking && prev !== 'speaking') return 'thinking';
        if (!thinking && prev === 'thinking') return 'idle';
        return prev;
      });
    };

    globalThis.addEventListener('agent-speech', onSpeech);
    globalThis.addEventListener('agent-thinking', onThinking);
    return () => {
      globalThis.removeEventListener('agent-speech', onSpeech);
      globalThis.removeEventListener('agent-thinking', onThinking);
    };
  }, []);

  const phaseLabel =
    phase === 'speaking' ? '🗣️ Speaking' : phase === 'thinking' ? '💭 Thinking' : '🎧 Listening';
  const phaseColor =
    phase === 'speaking' ? '#10b981' : phase === 'thinking' ? '#f59e0b' : '#64748b';

  return (
    <div
      style={{
        position: 'relative',
        width: '100%',
        height: 360,
        borderRadius: 14,
        overflow: 'hidden',
        background: 'linear-gradient(180deg, #eef2ff 0%, #e0e7ff 60%, #c7d2fe 100%)',
        border: '1px solid #c7d2fe',
        boxShadow: '0 4px 16px rgba(79, 70, 229, 0.12)',
      }}
    >
      <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />

      <div
        style={{
          position: 'absolute',
          top: 10,
          left: 12,
          background: phaseColor,
          color: '#fff',
          padding: '4px 10px',
          borderRadius: 999,
          fontSize: 12,
          fontWeight: 700,
          letterSpacing: 0.2,
          boxShadow: '0 2px 6px rgba(0,0,0,0.12)',
          zIndex: 5,
        }}
      >
        {phaseLabel}
      </div>

      <div
        style={{
          position: 'absolute',
          bottom: 10,
          right: 12,
          background: 'rgba(255,255,255,0.85)',
          color: '#3730a3',
          padding: '3px 8px',
          borderRadius: 6,
          fontSize: 11,
          fontWeight: 600,
          zIndex: 5,
        }}
      >
        AI Interviewer
      </div>

      {(status || loadFailed) && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#475569',
            fontSize: 13,
            fontWeight: 500,
            background: loadFailed ? 'rgba(255,255,255,0.85)' : 'transparent',
            zIndex: 4,
          }}
        >
          {loadFailed
            ? 'Avatar unavailable — set VITE_INTERVIEW_AVATAR_URL to a Ready Player Me .glb URL'
            : status}
        </div>
      )}
    </div>
  );
}
