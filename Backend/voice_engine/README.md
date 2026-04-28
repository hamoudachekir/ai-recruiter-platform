# Voice Engine

Pipeline audio pour entretien:

- `SileroVAD` pour la détection de silence et des segments de parole
- `FasterWhisperTranscriber` pour la transcription STT
- `PyannoteDiarizer` pour la diarisation des locuteurs
- `VoicePipeline` pour l'enchaînement complet VAD -> STT -> diarization

## Installation

```bash
pip install -r requirements.txt
```

Pour pyannote, il faut accepter les modèles gated sur Hugging Face et fournir un token dans `VoiceEngineConfig.hf_token`.

La diarisation est ignorée automatiquement si aucun token Hugging Face n'est fourni, ce qui permet de tester la transcription et la détection de parole sur une machine de développement classique.

## Fournir un token Hugging Face

Vous pouvez fournir le token de trois façons:

1. En argument CLI:

```bash
python -m voice_engine.manual_test --hf-token hf_xxxxx
```

2. Via une variable d'environnement:

```powershell
$env:VOICE_ENGINE_HF_TOKEN = "hf_xxxxx"
```

3. Avec les variables Hugging Face standard, que le CLI lit aussi:

```powershell
$env:HF_TOKEN = "hf_xxxxx"
$env:HUGGING_FACE_HUB_TOKEN = "hf_xxxxx"
```

Pour le backend Node, le service lit aussi `VOICE_ENGINE_HF_TOKEN`, `HF_TOKEN`, puis `HUGGING_FACE_HUB_TOKEN`.

## Exemple

```python
from voice_engine import VoiceEngineConfig, VoicePipeline

config = VoiceEngineConfig(
    hf_token="hf_xxxxx",
    language="fr",
    whisper_device="cuda",
)

pipeline = VoicePipeline(config)
turns = pipeline.process("interview_recording.wav")

for turn in turns:
    role = "Interviewer" if turn.speaker == "SPEAKER_00" else "Candidate"
    pause = f" (pause: {turn.silence_before_ms:.0f}ms)" if turn.silence_before_ms > 800 else ""
    print(f"{role}{pause}: {turn.text}")
```

## Test manuel au micro

```bash
python -m voice_engine.manual_test --duration 8 --whisper-model tiny --whisper-device cpu --whisper-compute-type int8
```

Le script enregistre votre micro, écrit un fichier WAV local, puis exécute le pipeline complet sur cet enregistrement.

Depuis la racine du dépôt sur Windows PowerShell, vous pouvez aussi lancer le test complet avec:

```powershell
.\scripts\test_voice_engine_mic.ps1
```

Ou directement via le fichier main Python du voice engine:

```powershell
.\.venv\Scripts\python.exe Backend\voice_engine\main.py --duration 8 --whisper-model tiny --whisper-device cpu --whisper-compute-type int8
```

Si vous êtes déjà dans `Backend/voice_engine`, n'utilisez pas `python main.py` avec Python global.
Utilisez plutôt:

```powershell
..\..\.venv\Scripts\python.exe main.py --duration 8 --whisper-model tiny --whisper-device cpu --whisper-compute-type int8
```

## Tester en live depuis la page Front

### Lancer speech stack + interview agent en une seule commande

Depuis la racine du dépôt, vous pouvez démarrer les deux services ensemble avec:

```powershell
.\Backend\voice_engine\scripts\run_voice_interview_stack.ps1
```

Par défaut, cela lance:
- Speech stack sur `http://127.0.0.1:8012/health`
- Interview agent sur `http://127.0.0.1:8013/health`

Vous pouvez aussi forcer un redémarrage ou changer le modèle LLM:

```powershell
.\Backend\voice_engine\scripts\run_voice_interview_stack.ps1 -ForceRestart -LLMProvider ollama -OllamaModel qwen2.5:14b-instruct
```


Cette partie est déjà branchée sur la page interview:

- Route front: `/interview/:interviewId`
- Bouton: `Start Voice Stream`
- Résultat affiché: `Voice Engine Output` avec les tours, le speaker et `silence before` en ms

### 1) Préparer la diarization (optionnel mais recommandé)

Si vous voulez les labels `SPEAKER_00`, `SPEAKER_01`, installez pyannote dans le même venv que le backend:

```powershell
.\.venv\Scripts\python.exe -m pip install pyannote.audio
```

Puis redémarrez le backend Node.

### 2) Lancer backend et frontend

Backend:

```powershell
cd Backend/server
node index.js
```

Frontend:

```powershell
cd Frontend
npm run dev
```

### 3) Ouvrir la page de test

Connectez-vous dans le front (token requis pour Socket.IO), puis ouvrez:

```text
http://localhost:5173/interview/test-live
```

Pour un test sans vidéo (audio-only), utilisez la page dédiée:

```text
http://localhost:5173/test-live
```

Pour améliorer la qualité STT (surtout phrases mixtes FR/EN), utilisez:

- `Language = Auto detect`
- `Whisper model = base` (ou `small` pour encore mieux)

### 4) Tester STT + silence

1. Cliquez `Start Call`.
2. Cliquez `Start Voice Stream`.
3. Parlez 2 ou 3 phrases avec une pause nette (>= 0.5s) entre elles.
4. Cliquez `Stop Voice Stream`.

Vous devez voir dans `Voice Engine Output`:

- le texte transcrit,
- les valeurs `silence before` (> 0 ms après une pause),
- le speaker (`SPEAKER_XX` si diarization active, sinon `UNKNOWN`).
