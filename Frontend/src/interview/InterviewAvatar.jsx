import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

// Candidate view uses a TalkingHead-compatible avatar (Ready Player Me /
// Oculus viseme morphs) sourced from github.com/met4citizen/TalkingHead.
// The morph-target strategy below auto-detects viseme_aa / viseme_O / etc.
const AVATAR_URL = import.meta.env.VITE_INTERVIEW_AVATAR_URL || '/avatars/mpfb.glb';

/* ── Lip-sync strategy ──────────────────────────────────────────────────────
 *
 *  Priority 1 — Morph targets (ARKit / ReadyPlayerMe / Reallusion names)
 *  Priority 2 — Jaw bone rotation  (CC_Base_JawRoot, jaw, Jaw, …)
 *  Priority 3 — Mesh translation   (for Sketchfab / FBX exports where the
 *                Mouth is a separate mesh with no morphs or bones)
 *
 *  The avatar loads, the code auto-detects which strategy is available,
 *  and drives the mouth from the Edge-TTS audio amplitude every frame.
 * ────────────────────────────────────────────────────────────────────────── */

/* Morph-target name patterns (ARKit, RPM, Reallusion, generic) */
const MORPH_PATTERNS = {
  mouthOpen:  [/^mouthOpen$/i,  /^jawOpen$/i,   /^Mouth_Open$/i,  /mouth.*open/i,  /jaw.*open/i,  /viseme_open/i],
  mouthWide:  [/^viseme_aa$/i,  /^viseme_E$/i,  /^ae_aa$/i,       /mouth.*wide/i,  /mouth.*stretch/i, /viseme_aa/i],
  mouthRound: [/^viseme_O$/i,   /^viseme_OH$/i, /^mouthFunnel$/i, /mouth.*round/i, /mouth.*funnel/i,  /viseme_oh/i],
  mouthFv:    [/^viseme_FF$/i,  /^fv$/i,        /viseme_ff/i,     /mouth.*fv/i],
  blinkL:     [/^eyeBlinkLeft$/i,  /^Eye_Blink_L$/i, /blink.*left/i,  /leye.*close/i, /eye_blink_l/i],
  blinkR:     [/^eyeBlinkRight$/i, /^Eye_Blink_R$/i, /blink.*right/i, /reye.*close/i, /eye_blink_r/i],
  smileL:     [/^mouthSmileLeft$/i,  /^Mouth_Smile_L$/i, /lsmile/i, /smile.*left/i],
  smileR:     [/^mouthSmileRight$/i, /^Mouth_Smile_R$/i, /rsmile/i, /smile.*right/i],
};

/* Jaw bone names across Reallusion CC, Mixamo, custom rigs */
const JAW_BONE_NAMES = [
  'CC_Base_JawRoot', 'jawRoot', 'jaw_root',
  'jaw', 'Jaw', 'jaw_ctrl', 'jaw_lower',
  'lower_jaw', 'jawBone', 'mandible', 'chin',
];

/* Mesh node names that are good candidates for the mouth / jaw group */
const MOUTH_MESH_NAMES = ['Mouth', 'mouth', 'Jaw', 'jaw', 'teeth', 'Teeth',
  'TeethDown', 'teethDown', 'h_TeethDown', 'LowerTeeth', 'lowerTeeth'];

/* Mesh node names that are good candidates for the eye meshes */
const EYE_MESH_NAMES = ['Eye', 'eye', 'Eyelid', 'eyelid', 'Eyelashes', 'eyelashes'];

export default function InterviewAvatar() {
  const containerRef = useRef(null);

  /* Shared render state */
  const stateRef = useRef({
    renderer: null, scene: null, camera: null,
    rafId: 0,
    nextBlinkAt: 0,
    blinkPhase: 0,
    isSpeaking: false,

    /* Strategy 1 — morphs */
    meshes: [],

    /* Strategy 2 — jaw bone */
    jawBone: null,
    jawRestAngle: 0,

    /* Strategy 3 — mesh translation (Sketchfab / FBX avatars) */
    mouthObject: null,          // THREE.Object3D to translate
    mouthRestY: 0,              // world-space rest Y
    jawDropMax: 0.03,           // world units (calibrated from bounding box)
    eyeObjects: [],             // [{obj, restScaleY}]

    /* Strategy 4 — unnamed morphs (DAZ/MetaHuman with no extras.targetNames) */
    unnamedMorphMeshes: [],     // meshes with morph influences but no dict names

    strategy: 'none',           // 'morph' | 'bone' | 'mesh' | 'morph-indexed' | 'none'
  });

  /* Web Audio */
  const audioCtxRef    = useRef(null);
  const analyserRef    = useRef(null);
  const srcNodeRef     = useRef(null);
  const dataRef        = useRef(null);
  const lastAudioElRef = useRef(null);
  const ampRef         = useRef(0);

  /* Morph rig (strategy 1 only) */
  const rigRef = useRef(null);

  const [status, setStatus]         = useState('Loading avatar…');
  const [loadFailed, setLoadFailed] = useState(false);

  /* ── Web Audio ──────────────────────────────────────────────── */

  const connectAudio = (audioEl) => {
    if (!audioEl || audioEl === lastAudioElRef.current) return;
    lastAudioElRef.current = audioEl;
    try {
      if (!audioCtxRef.current || audioCtxRef.current.state === 'closed')
        audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
      const actx = audioCtxRef.current;
      if (actx.state === 'suspended') actx.resume().catch(() => {});
      try { srcNodeRef.current?.disconnect(); } catch {}

      const analyser = actx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.55;

      const src = actx.createMediaElementSource(audioEl);
      src.connect(analyser);
      analyser.connect(actx.destination);

      analyserRef.current = analyser;
      srcNodeRef.current  = src;
      dataRef.current     = new Uint8Array(analyser.frequencyBinCount);
    } catch (e) {
      console.warn('[Avatar] audio connect:', e.message);
    }
  };

  const readAmplitude = () => {
    if (!analyserRef.current || !dataRef.current || !stateRef.current.isSpeaking) return 0;
    analyserRef.current.getByteFrequencyData(dataRef.current);
    // Speech frequency bins 2-25 ≈ 250-3500 Hz
    let sum = 0;
    for (let i = 2; i <= 25; i++) sum += dataRef.current[i];
    return (sum / 24) / 255;
  };

  /* ── Morph helpers ─────────────────────────────────────────── */

  const setMorph = (name, value) => {
    stateRef.current.meshes.forEach((mesh) => {
      const idx = mesh.morphTargetDictionary?.[name];
      if (idx !== undefined)
        mesh.morphTargetInfluences[idx] = Math.max(0, Math.min(1, value));
    });
  };

  const lerpMorph = (name, target, k) => {
    stateRef.current.meshes.forEach((mesh) => {
      const idx = mesh.morphTargetDictionary?.[name];
      if (idx === undefined) return;
      const cur = mesh.morphTargetInfluences[idx];
      mesh.morphTargetInfluences[idx] = cur + (target - cur) * k;
    });
  };

  const resolveMorphName = (allNames, patterns) => {
    for (const pat of patterns) {
      const found = allNames.find((n) => pat.test(n));
      if (found) return found;
    }
    return null;
  };

  /* ── Scene / GLB loader ─────────────────────────────────────── */

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;

    const w = container.clientWidth  || 480;
    const h = container.clientHeight || 600;

    const scene    = new THREE.Scene();
    scene.background = null;

    const camera = new THREE.PerspectiveCamera(22, w / h, 0.01, 200);
    camera.position.set(0, 1.7, 0.55);
    camera.lookAt(0, 1.65, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(w, h);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = false;
    container.appendChild(renderer.domElement);

    /* Three-point lighting for realistic skin tone */
    scene.add(new THREE.AmbientLight(0xfff4e6, 0.85));
    const key = new THREE.DirectionalLight(0xfff0dd, 1.6);
    key.position.set(0.8, 2.5, 2.0);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xd0e8ff, 0.7);
    fill.position.set(-1.8, 1.0, 0.5);
    scene.add(fill);
    const rim = new THREE.DirectionalLight(0xffffff, 0.3);
    rim.position.set(0, 2.0, -2.5);
    scene.add(rim);

    stateRef.current.scene    = scene;
    stateRef.current.camera   = camera;
    stateRef.current.renderer = renderer;

    const draco = new DRACOLoader();
    draco.setDecoderPath('/draco/');
    const loader = new GLTFLoader();
    loader.setDRACOLoader(draco);

    MeshoptDecoder.ready.then(() => {
      if (!stateRef.current.renderer) return;
      loader.setMeshoptDecoder(MeshoptDecoder);

      loader.load(
        AVATAR_URL,
        (gltf) => {
          const root = gltf.scene;
          scene.add(root);

          /* ── 1. Collect all meshes, bones ───────────────────── */
          const meshes   = [];
          const allBones = [];
          const allObjs  = [];

          const unnamedMorphMeshes = [];

          root.traverse((obj) => {
            allObjs.push(obj);
            if (obj.isBone) allBones.push(obj);
            if (!obj.isMesh || !obj.morphTargetInfluences) return;

            /* Patch morphTargetDictionary from extras if Three.js missed it */
            if (!obj.morphTargetDictionary || !Object.keys(obj.morphTargetDictionary).length) {
              const src = obj.userData?.targetNames || obj.geometry?.userData?.targetNames;
              if (src?.length) {
                obj.morphTargetDictionary = Object.fromEntries(src.map((n, i) => [n, i]));
              }
            }
            if (obj.morphTargetDictionary && Object.keys(obj.morphTargetDictionary).length) {
              meshes.push(obj);
            } else if (obj.morphTargetInfluences.length > 0) {
              /* Unnamed morphs — collect for Strategy 4 */
              unnamedMorphMeshes.push(obj);
            }
          });

          stateRef.current.meshes = meshes;

          const allMorphNames = Array.from(
            new Set(meshes.flatMap((m) => Object.keys(m.morphTargetDictionary || {})))
          );

          console.log(`[Avatar] ${meshes.length} morph mesh(es), ${allMorphNames.length} morph(s)`);
          if (allMorphNames.length) console.log('[Avatar] morphs:', allMorphNames.join(', '));
          console.log('[Avatar] bones:', allBones.map((b) => b.name).filter(Boolean).join(', ') || 'none');
          console.log('[Avatar] objects:', allObjs.map((o) => o.name).filter(Boolean).join(', '));

          /* ── 2. Detect strategy ─────────────────────────────── */
          let tryMeshFallback = false;

          if (allMorphNames.length) {
            /* ── Strategy 1: morph targets ── */
            const rig = {};
            for (const [key, patterns] of Object.entries(MORPH_PATTERNS))
              rig[key] = resolveMorphName(allMorphNames, patterns);
            rigRef.current = rig;
            stateRef.current.strategy = 'morph';
            console.log('[Avatar] strategy=morph, rig:', rig);

          } else if (allBones.length) {
            /* ── Strategy 2: jaw bone ── */
            const jawBone = allBones.find((b) =>
              JAW_BONE_NAMES.some((n) => b.name === n || b.name.toLowerCase().includes('jaw')),
            );
            if (jawBone) {
              stateRef.current.jawBone      = jawBone;
              stateRef.current.jawRestAngle = jawBone.rotation.x;
              stateRef.current.strategy     = 'bone';
              console.log(`[Avatar] strategy=bone, jaw="${jawBone.name}"`);
            } else {
              /* No jaw bone found — fall through to mesh strategy */
              console.warn('[Avatar] bones found but no jaw bone — trying mesh strategy');
              tryMeshFallback = true;
            }
          }

          if (!allMorphNames.length && (!allBones.length || tryMeshFallback)) {
            /* ── Strategy 3: mesh translation (Sketchfab / FBX / DAZ) ── */
            /* Find the mouth / jaw mesh object */
            let mouthObj = null;
            for (const name of MOUTH_MESH_NAMES) {
              mouthObj = root.getObjectByName(name);
              if (mouthObj) break;
            }
            if (!mouthObj) {
              const byNameIncludes = (needle) =>
                allObjs
                  .filter((o) => o.isMesh)
                  .filter((o) => (o.name || '').toLowerCase().includes(needle));

              // Pass 1: mouth/jaw (avoid selecting teeth-only meshes)
              const mouthCandidates = [
                ...byNameIncludes('mouth'),
                ...byNameIncludes('jaw'),
                ...byNameIncludes('lip'),
              ];

              if (mouthCandidates.length) {
                mouthObj = mouthCandidates[0];
              } else {
                // Pass 2: teeth (last resort)
                const teethCandidates = byNameIncludes('teeth');
                mouthObj = teethCandidates[0] || null;
              }
            }

            if (mouthObj) {
              const wp = new THREE.Vector3();
              mouthObj.getWorldPosition(wp);
              stateRef.current.mouthObject = mouthObj;
              stateRef.current.mouthRestY  = mouthObj.position.y; // local Y is stable

              /* Calibrate jaw-drop from the selected mouth/jaw object bounding box.
               * This prevents "teeth-only" rigs from moving too little. */
              const headMeshForScale =
                root.getObjectByName('Head_Head_0') ||
                root.getObjectByName('Head') ||
                root.getObjectByName('head') ||
                root;
              const headBox = new THREE.Box3().setFromObject(headMeshForScale);
              const headH = headBox.getSize(new THREE.Vector3()).y;
              const mouthBox = new THREE.Box3().setFromObject(mouthObj);
              const mouthH = mouthBox.getSize(new THREE.Vector3()).y || headH;

              const drop = mouthH * 0.28; // strong response for speaking
              const minDrop = headH * 0.03;
              const maxDrop = headH * 0.10;
              stateRef.current.jawDropMax = Math.max(minDrop, Math.min(maxDrop, drop));
              console.log(`[Avatar] strategy=mesh, mouth="${mouthObj.name}", jawDropMax=${stateRef.current.jawDropMax.toFixed(4)}`);

              /* Eye meshes for blinking */
              const eyeObjs = [];
              for (const name of EYE_MESH_NAMES) {
                const o = root.getObjectByName(name);
                if (o && !eyeObjs.includes(o)) eyeObjs.push(o);
              }
              /* Also collect children of eye nodes */
              allObjs.forEach((o) => {
                if (!o.name) return;
                const n = o.name.toLowerCase();
                if ((n.includes('eye') || n.includes('eyelash')) && !eyeObjs.includes(o))
                  eyeObjs.push(o);
              });
              stateRef.current.eyeObjects = eyeObjs.map((o) => ({
                obj: o,
                restScaleY: o.scale.y,
              }));
              console.log('[Avatar] eye objects:', eyeObjs.map((o) => o.name).join(', '));

              stateRef.current.strategy = 'mesh';
            } else {
              stateRef.current.strategy = 'none';
              console.warn('[Avatar] no mouth mesh found — trying unnamed morph fallback');
            }
          }

          /* ── Strategy 4: unnamed morph targets (DAZ/MetaHuman exports) ── */
          if (stateRef.current.strategy === 'none' && unnamedMorphMeshes.length) {
            /* Prefer teeth/mouth meshes — their morphs are jaw-specific */
            const teethMesh = unnamedMorphMeshes.find((m) =>
              m.name && (
                m.name.toLowerCase().includes('teeth') ||
                m.name.toLowerCase().includes('mouth') ||
                m.name.toLowerCase().includes('jaw')
              ),
            ) || unnamedMorphMeshes[0];
            stateRef.current.unnamedMorphMeshes = [teethMesh];
            stateRef.current.strategy = 'morph-indexed';
            console.log(
              `[Avatar] strategy=morph-indexed, driving teeth morph[0] on "${teethMesh.name}" (${teethMesh.morphTargetInfluences.length} morphs)`
            );
          }

          /* ── Auto-frame camera on the face ──────────────────────
           * IMPORTANT: some models (DAZ/Poser/MENA) store bone nodes in
           * centimeter world-space while the skinned mesh root has scale 0.01
           * that converts cm → m at render time. Using bone world positions
           * for camera placement then points the camera at centimeter-space
           * coordinates (~150 units up) while the visible mesh is only 0–1.8 m
           * tall — resulting in the camera showing only the feet or nothing.
           *
           * Fix: build the bounding box from RENDERED MESH objects only
           * (isMesh / isSkinnedMesh), which always carry the correct world
           * scale via matrixWorld. Bones are intentionally excluded.
           * Then take the upper ~26 % of the body as the head region for a
           * tight portrait frame.
           * ──────────────────────────────────────────────────────────── */
          const bodyBox = new THREE.Box3();
          root.traverse((obj) => {
            if (!obj.isMesh && !obj.isSkinnedMesh) return;
            const mb = new THREE.Box3().setFromObject(obj);
            if (!mb.isEmpty()) bodyBox.union(mb);
          });
          if (bodyBox.isEmpty()) bodyBox.setFromObject(root); // last resort

          const bodySize = bodyBox.getSize(new THREE.Vector3());
          const bodyH    = bodySize.y > 0 ? bodySize.y : 1.7;

          /* Head region = upper ~26 % of the full body height */
          const headRegionH  = bodyH * 0.26;
          const headCenterY  = bodyBox.max.y - bodyH * 0.12; // eye/nose level
          const cx = (bodyBox.min.x + bodyBox.max.x) / 2;
          const cz = (bodyBox.min.z + bodyBox.max.z) / 2;

          /* Portrait distance so head fills ~85 % of the vertical FOV */
          const fovRad = camera.fov * (Math.PI / 180);
          const dist   = (headRegionH * 0.85) / (2 * Math.tan(fovRad / 2));

          camera.near = dist * 0.05;
          camera.far  = dist * 60;
          camera.updateProjectionMatrix();

          camera.position.set(cx, headCenterY, cz + dist);
          camera.lookAt(cx, headCenterY - headRegionH * 0.04, cz);
          console.log(`[Avatar] camera: bodyH=${bodyH.toFixed(3)}, headH=${headRegionH.toFixed(3)}, dist=${dist.toFixed(3)}`);

          stateRef.current.nextBlinkAt = performance.now() + 2000 + Math.random() * 2000;
          setStatus('');
        },
        undefined,
        (err) => {
          console.error('[Avatar] load failed:', AVATAR_URL, err);
          setLoadFailed(true);
          setStatus('Avatar unavailable');
        },
      );
    });

    /* ── Render loop ────────────────────────────────────────── */
    const tick = () => {
      stateRef.current.rafId = requestAnimationFrame(tick);
      const s = stateRef.current;
      if (!s.renderer || !s.scene || !s.camera) return;

      const now = performance.now();
      const t   = now / 1000;
      const rig = rigRef.current || {};

      /* Smooth amplitude — fast attack, slow release */
      const raw = readAmplitude();
      const kAmp = raw > ampRef.current ? 0.5 : 0.12;
      ampRef.current += (raw - ampRef.current) * kAmp;
      const amp  = ampRef.current;
      const wave = (Math.sin(t * 8) + 1) * 0.5; // 0-1 at 8 Hz

      /* ── Strategy 1: morph targets ───────────────────────── */
      if (s.strategy === 'morph' && s.meshes.length) {
        if (s.isSpeaking) {
          if (rig.mouthOpen)  lerpMorph(rig.mouthOpen,  amp * 0.92,            0.40);
          if (rig.mouthWide)  lerpMorph(rig.mouthWide,  amp * wave * 0.65,     0.30);
          if (rig.mouthRound) lerpMorph(rig.mouthRound, amp * (1-wave) * 0.50, 0.30);
          if (rig.mouthFv)    lerpMorph(rig.mouthFv,    amp * 0.30,            0.25);
        } else {
          if (rig.mouthOpen)  lerpMorph(rig.mouthOpen,  0, 0.10);
          if (rig.mouthWide)  lerpMorph(rig.mouthWide,  0, 0.08);
          if (rig.mouthRound) lerpMorph(rig.mouthRound, 0, 0.08);
          if (rig.mouthFv)    lerpMorph(rig.mouthFv,    0, 0.08);
          if (rig.smileL)     lerpMorph(rig.smileL, 0.12, 0.04);
          if (rig.smileR)     lerpMorph(rig.smileR, 0.12, 0.04);
        }
      }

      /* ── Strategy 2: jaw bone ────────────────────────────── */
      if (s.strategy === 'bone' && s.jawBone) {
        const targetAngle = s.jawRestAngle + (s.isSpeaking ? amp * 0.22 : 0);
        s.jawBone.rotation.x +=
          (targetAngle - s.jawBone.rotation.x) * (s.isSpeaking ? 0.40 : 0.12);
      }

      /* ── Strategy 3: mesh translation ────────────────────── */
      if (s.strategy === 'mesh' && s.mouthObject) {
        /* Jaw-drop: translate mouth group down in local Y */
        const drop = s.isSpeaking ? amp * s.jawDropMax : 0;
        const targetY = s.mouthRestY - drop;
        const kY = s.isSpeaking ? 0.40 : 0.12;
        s.mouthObject.position.y += (targetY - s.mouthObject.position.y) * kY;

        /* Also open slightly wider on X (lips parting) */
        const targetSX = 1 + (s.isSpeaking ? amp * 0.06 : 0);
        s.mouthObject.scale.x += (targetSX - s.mouthObject.scale.x) * 0.3;

        /* Eye blink via scale Y */
        let blinkV = 0;
        if (now >= s.nextBlinkAt) {
          s.blinkPhase  = 1;
          s.nextBlinkAt = now + 2800 + Math.random() * 3200;
        }
        if (s.blinkPhase > 0) {
          s.blinkPhase = Math.max(0, s.blinkPhase - 0.13);
          blinkV = s.blinkPhase < 0.5
            ? s.blinkPhase * 2
            : (1 - s.blinkPhase) * 2;
        }
        s.eyeObjects.forEach(({ obj, restScaleY }) => {
          const targetScaleY = restScaleY * (1 - blinkV * 0.88);
          obj.scale.y += (targetScaleY - obj.scale.y) * 0.18;
        });
      }

      /* ── Strategy 4: unnamed morph-indexed (DAZ / MetaHuman) ─── */
      if (s.strategy === 'morph-indexed' && s.unnamedMorphMeshes?.length) {
        const target = s.isSpeaking ? amp * 0.80 : 0;
        const k = s.isSpeaking ? 0.42 : 0.14;
        s.unnamedMorphMeshes.forEach((mesh) => {
          if (!mesh.morphTargetInfluences?.length) return;
          const cur = mesh.morphTargetInfluences[0];
          mesh.morphTargetInfluences[0] = cur + (target - cur) * k;
        });
      }

      /* ── Morph / bone blink ─────────────────────────────── */
      if (s.strategy === 'morph' && (rig.blinkL || rig.blinkR)) {
        let blinkV = 0;
        if (now >= s.nextBlinkAt) {
          s.blinkPhase  = 1;
          s.nextBlinkAt = now + 2800 + Math.random() * 3200;
        }
        if (s.blinkPhase > 0) {
          s.blinkPhase = Math.max(0, s.blinkPhase - 0.13);
          blinkV = s.blinkPhase < 0.5
            ? s.blinkPhase * 2
            : (1 - s.blinkPhase) * 2;
        }
        if (rig.blinkL) setMorph(rig.blinkL, blinkV);
        if (rig.blinkR) setMorph(rig.blinkR, blinkV);
      }

      /* Subtle idle head sway */
      s.scene.rotation.y = Math.sin(t * 0.35) * 0.025;

      s.renderer.render(s.scene, s.camera);
    };
    tick();

    /* ── Resize observer ────────────────────────────────────── */
    const ro = new ResizeObserver(() => {
      const nw = container.clientWidth  || 480;
      const nh = container.clientHeight || 600;
      renderer.setSize(nw, nh);
      camera.aspect = nw / nh;
      camera.updateProjectionMatrix();
    });
    ro.observe(container);

    return () => {
      cancelAnimationFrame(stateRef.current.rafId);
      ro.disconnect();
      renderer.dispose();
      draco.dispose();
      renderer.domElement.parentNode?.removeChild(renderer.domElement);
      stateRef.current.renderer = null;
      stateRef.current.scene    = null;
      stateRef.current.camera   = null;
      stateRef.current.meshes   = [];
      try { audioCtxRef.current?.close(); } catch {}
    };
  }, []);

  /* ── Speech events ──────────────────────────────────────────── */

  useEffect(() => {
    const onSpeech = (ev) => {
      const speaking = !!ev?.detail?.speaking;
      stateRef.current.isSpeaking = speaking;
      if (speaking) {
        const el = window.__agentAudioEl;
        if (el) connectAudio(el);
      } else {
        ampRef.current = 0;
      }
    };

    globalThis.addEventListener('agent-speech', onSpeech);
    return () => globalThis.removeEventListener('agent-speech', onSpeech);
  }, []);

  /* ── Render ─────────────────────────────────────────────────── */

  return (
    <div style={{
      position: 'relative',
      width: '100%',
      height: '100%',
      minHeight: 340,
      overflow: 'hidden',
      background: 'transparent',
    }}>
      <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />

      {(status || loadFailed) && (
        <div style={{
          position: 'absolute', inset: 0, zIndex: 4,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: loadFailed ? '#f87171' : '#64748b',
          fontSize: 13, fontWeight: 500,
        }}>
          {loadFailed
            ? `Could not load ${AVATAR_URL}`
            : status}
        </div>
      )}
    </div>
  );
}
