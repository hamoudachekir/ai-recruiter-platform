# Environment Configuration Reference

## Quick Setup Check

Copy and verify these critical variables are in your `.env` file:

### ✅ LLM & Interview Agent
```env
LLM_PROVIDER=nvidia
NVIDIA_API_KEY=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
NVIDIA_MODEL=meta/llama-3.1-8b-instruct
AGENT_PORT=8013
AGENT_MAX_TOKENS=200
AGENT_TRANSCRIPT_TAIL_TURNS=4
AGENT_SHORT_TERM_MEMORY_TURNS=4
AGENT_TEMPERATURE=0.18
```

### ✅ Speech-to-Text (Faster-Whisper)
- Configured in Backend/voice_engine/
- No .env needed - uses system default

### ✅ Text-to-Speech (ElevenLabs)
```env
FW_TTS_PROVIDER=elevenlabs
ELEVENLABS_API_KEY=sk_1664a51094d24f8254b23e207c8edd1db099fcf5992d6f51
ELEVENLABS_MODEL_ID=eleven_flash_v2_5
ELEVENLABS_VOICE_ID=EXAVITQu4vr4xnSDxMaL
FW_PRELOAD_TTS=1
```

### ✅ Avatar (3D Face with Lip-Sync)
```env
VITE_INTERVIEW_AVATAR_URL=https://models.readyplayer.me/64bfa15f0e72c63d7c3934a6.glb?morphTargets=ARKit&textureAtlas=1024
```

## Speech Pipeline Explanation

```
CANDIDATE SPEAKS
    ↓ (WebRTC or HTML5 Audio API)
VAD DETECTS VOICE (600ms silence = end of utterance)
    ↓ (faster-whisper STT)
TRANSCRIPTION: "I have 5 years of experience"
    ↓ (live draft bubble shown instantly)
STT_FINALIZE_SILENCE_MS = 220ms wait
    ↓
NLINESMS EVENT DISPATCHED
    ↓
MESSAGE APPEARS IN CHAT
    ↓
SENT TO AGENT VIA SOCKET: "agent:candidate-turn"
    ↓ (NVIDIA LLM processes)
AGENT THINKS (200 tokens max, 0.18 temp = focused)
    ↓
AGENT RESPONSE: "That's impressive. Tell me about..."
    ↓ (ElevenLabs voice)
AVATAR SPEAKS WITH LIP-SYNC
    ↓
CANDIDATE HEARS RESPONSE
    ↓
LOOP CONTINUES...
```

## Key Parameters Tuning

### Response Latency Control
```env
AGENT_MAX_TOKENS=200         # Lower = faster responses (was 320)
AGENT_TEMPERATURE=0.18       # Lower = more focused answers
AGENT_TRANSCRIPT_TAIL_TURNS=4 # Context window size
```

### Speech Detection Sensitivity
In `CallRoomActive.jsx`:
```javascript
VAD_RMS_THRESHOLD = 0.015          // Voice detection threshold
VAD_START_RMS_THRESHOLD = 0.020    // Start recording threshold  
VAD_SILENCE_MS = 600               // How long silence = end utterance
STT_FINALIZE_SILENCE_MS = 220      // After VAD, wait this for final text
```

## Debugging Each Component

### 1. Test Avatar Loading
```bash
# Browser console
navigator.userAgent  # Should show Three.js capable browser
# Look for: [InterviewAvatar] ready — 4 meshes, 52 morphs
```

### 2. Test Microphone + STT
```bash
# Browser console
# Speak something
# Look for: 📝 Transcription update received: "your text here"
```

### 3. Test Agent Connection
```bash
# Browser console  
# Look for: ✅ Socket connected
# Look for: 🤖 Agent message received: "agent question"
```

### 4. Test TTS Playback
```bash
# Browser console
# Should see: 📢 Using ElevenLabs for agent speech
# OR: 📢 Using Streamoji for agent speech
# Audio should play with avatar lip-sync
```

## Health Checks

Run these in browser console:

```javascript
// Check socket
socketRef.current?.connected  // Should be true

// Check room loaded  
roomDbIdRef.current  // Should have MongoDB ID

// Check token valid
isTokenExpired(token)  // Should be false

// Check audio context
audioCtxRef.current?.state  // Should be 'running'
```

## File Locations Reference

- Avatar: `Frontend/public/avatar.glb` (or via VITE_INTERVIEW_AVATAR_URL)
- DRACO: `Frontend/public/draco/` (decoder files for compression)
- STT: `Backend/voice_engine/stt_service.py`
- Agent: `Backend/scheduling/app/services/` (LLM integration)
- TTS: Backend routes `/api/voice/tts` (ElevenLabs API)
