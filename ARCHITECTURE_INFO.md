# ARCHITECTURE_INFO.md — NextHire (AI Recruiter Platform)

> Document généré par analyse statique du code et de la configuration présents dans
> `C:\Users\wh\ai-recruiter-platform`. Chaque information est sourcée par le chemin du
> fichier d'où elle provient. Les informations introuvables sont marquées **NON TROUVÉ**.
>
> ⚠️ Le dossier `rapportstage/` est le rapport de PFE LaTeX, **pas** un composant logiciel.
> L'architecture réelle décrite ici est celle du code à la racine (`Backend/`, `Frontend/`).

---
## 1. Services / composants

La plateforme est un ensemble de **microservices polyglottes** (1 backend Node + 1 service
FastAPI de scheduling + plusieurs services Python d'IA/vision/voix + 6 micro-services Flask
d'IA classique + 2 frontends React/Vite). Tous partagent une **seule base MongoDB** `ai_recruiter`.

| # | Service | Chemin | Langage / Framework | Responsabilité | Port | Point d'entrée |
|---|---------|--------|---------------------|----------------|------|----------------|
| 1 | **Node backend / API + WebSocket** | `Backend/server/` | Node.js / Express 4 + Socket.IO 4 | API REST principale, auth, jobs, candidatures, salles d'appel temps réel, orchestration des services IA | **3001** | `index.js` |
| 2 | **Frontend principal (SPA)** | `Frontend/` | React 19 / Vite 6 | Application web principale (front office + back office/dashboard) | **5173** | `index.html` → `src/main.jsx` |
| 3 | **Frontend login (SPA séparée)** | `Frontend/login/` | React / Vite | Portail de login séparé | **5174** *(via `.env.example` `FRONTEND_LOGIN_PORT=5174`)* | `Frontend/login/index.html` |
| 4 | **Interview Scheduling Service** | `Backend/scheduling/` | Python / FastAPI | Planification d'entretiens, Google Calendar, emails | **5004** | `main.py` → `app/main.py` |
| 5 | **Post-Interview Analysis Service** | `Backend/analysis_service/` | Python / FastAPI + LangGraph | Génération du rapport post-entretien (pipeline LangGraph), vision/comportement, ranking, ATS, copilot | **8090** | `app/main.py` (`uvicorn app.main:app`) |
| 6 | **Interview Agent (LLM)** | `Backend/voice_engine/interview_agent/` | Python / FastAPI | Agent d'entretien adaptatif (IRT), pose les questions en direct, scoring | **8013** | `agent_server.py` (`app`) |
| 7 | **Speech Stack (STT/TTS)** | `Backend/voice_engine/speech_stack/` | Python / FastAPI | Transcription (faster-whisper) + synthèse vocale (edge-tts / TTS) + sentiment | **8012** | `api_server.py` (`app`) |
| 8 | **Face Verification Service** | `Backend/face_verification_service/` | Python / Flask | Vérification d'identité par reconnaissance faciale (InsightFace) | **8011** | `app.py` |
| 9 | **YOLO Vision Service** | `Backend/yolo-service/` | Python / FastAPI | Détection objective d'objets/personnes (téléphone, livre, écran, nb. de personnes) pour l'intégrité | **8001** | `app.py` |
| 10 | **Voice Engine (lib + workers)** | `Backend/voice_engine/` | Python | Bibliothèque/pipeline STT temps réel + diarisation, worker temps réel lancé par le Node | N/A (sous-processus) | `pipeline.py`, `realtime_worker.py` |
| 11 | **AI — Parseur CV** | `Backend/server/AI/iA4.py` | Python / Flask | Parsing de CV (spaCy, pdfplumber, PaddleOCR, TF-IDF) | **5002** | `iA4.py` |
| 12 | **AI — Hiring Model** | `Backend/server/AI/hiring_model.py` | Python / Flask | Prédiction d'embauche (`/predict-from-skills`) | **5000** | `hiring_model.py` |
| 13 | **AI — Recommendation Service** | `Backend/server/AI/recommendation_service.py` | Python / Flask | Recommandation de jobs / matching skills (`/recommend`, `/refresh-index`) | **5001** | `recommendation_service.py` |
| 14 | **AI — Interview Score Model** | `Backend/server/AI/interview_score_model.py` | Python / Flask | Scoring d'entretien (`/predict`) | **7000** | `interview_score_model.py` |
| 15 | **AI — Clustering** | `Backend/server/AI/clustering.py` | Python / Flask | Clustering de candidats | **5006** | `clustering.py` |
| 16 | **AI — Quiz Generation** | `Backend/server/AI/quiz_generation_service.py` | Python / Flask | Génération de quiz adaptatifs (`/generate-quiz`, `/adaptive-next-page`) | **5003** | `quiz_generation_service.py` |

**Sources des ports :**
- Node 3001 : `Backend/server/index.js:7145` (`const PORT = process.env.PORT || 3001`) + `.env.example:2`.
- Frontend 5173 : `Frontend/vite.config.js:9` (`strictPort: true`).
- Frontend login 5174 : `.env.example:11` (vite.config.js du login ne fixe pas explicitement le port → valeur issue de l'env).
- Scheduling 5004 : `Backend/scheduling/app/config.py:15` + `docker-compose.yml`.
- Analysis 8090 : `Backend/scripts/run_call_room_full_stack.ps1:126` (`uvicorn ... --port 8090`).
- Interview Agent 8013 : `Backend/server/services/interviewAgentService.js:4` (`INTERVIEW_AGENT_URL || http://localhost:8013`).
- Speech 8012 : `Backend/voice_engine/scripts/run_voice_interview_stack.ps1:2` (`[int]$SpeechPort = 8012`).
- Face 8011 : `Backend/face_verification_service/app.py:424` (`os.getenv("PORT", 8011)`) + `start.ps1`.
- YOLO 8001 : `Backend/yolo-service/app.py:429` (`os.getenv("PORT", "8001")`) + `.env.example:49`.
- AI Flask (5000/5001/5002/5003/5006/7000) : `Backend/server/AI/start_all_ai.py` / `start_all_ai.bat` + `app.run(port=...)` dans chaque fichier (`iA4.py:1101` → 5002, `quiz_generation_service.py:1534` → 5003, `recommendation_service.py:640` → 5001).

> ℹ️ Le script de lancement « stack call-room » (`START_CALLROOM.bat` / `run_call_room_full_stack.ps1`)
> ne démarre QUE : Node 3001, Frontend 5173, Speech 8012, Agent 8013, Face 8011, YOLO 8001, Analysis 8090.
> Les 6 micro-services Flask `Backend/server/AI/*` et le service Scheduling 5004 ont leurs propres
> lanceurs (`start_all_ai.bat`, `main.py`, `docker-compose.yml`).

---

## 2. Frontend

- **Nombre de portails / SPA : 2 applications Vite distinctes**
  - `Frontend/` — SPA principale (port 5173). Une seule application React qui contient **à la fois**
    le *front office* (candidat / pages publiques) et le *back office* (dashboard recruteur/admin),
    séparés **par routes**, pas par application.
  - `Frontend/login/` — SPA de login séparée (port 5174 d'après `.env.example:11`), avec son propre
    `package.json`, `vite.config.js` et `index.html`.
- **Séparation recruteur / candidat / admin = par routes et gardes de route**, dans `Frontend/src/App.jsx` :
  - Front office (candidat / public) : `/`, `/home`, `/about`, `/login`, `/register`, `/job/:id`,
    `/profile/:id`, `/quiz/:jobId`, `/candidate/scheduling`, `/call-room/:roomId`, `/messages`, etc.
  - Entreprise / recruteur : `/entreprise/:id`, `/entreprise/:id/jobs/new` (`JobWizard`),
    `/entreprise/:entrepriseId/interview-rooms`, `.../compare` (`CandidateComparison`).
  - Back office / dashboard : routes sous `/dashboard` (`DashboardLayoutWrapper`, `ManageCandidates`, …).
  - **Admin** : composant `AdminProtectedRoute` (`Frontend/src/App.jsx:19,57`) → garde de route par rôle admin.
- **Framework & build :** React 19 + **Vite 6** (`Frontend/package.json`, `vite.config.js`).
  Build via `vite build` (dossier `dist/` présent). UI : MUI, Radix UI, Bootstrap, TailwindCSS,
  Three.js / react-three-fiber, ApexCharts/Recharts, MediaPipe tasks-vision, webrtc-adapter.
- **Titre de l'app :** `NEXTHIRE` (`Frontend/index.html`).
- **Communication avec le backend :**
  - **REST** via `axios` ; proxy Vite `'/api' → http://localhost:3001` (`Frontend/vite.config.js:12-18`).
  - **WebSocket** via `socket.io-client` (`Frontend/package.json:62`) vers le Node (Socket.IO sur 3001).
  - **WebRTC** pour les salles d'appel (`webrtc-adapter` côté front ; `wrtc` côté Node).
  - Variables d'env front préfixées `VITE_` (`vite.config.js:6`), ex. `VITE_FACE_VERIFY_*` (`.env.example:120-122`).

---

## 3. API Gateway / point d'entrée

- **Pas de gateway dédiée (pas de Nginx, Kong, Traefik).** Le **serveur Node Express**
  `Backend/server/index.js` joue le rôle de **point d'entrée unique / BFF** : le frontend ne parle
  qu'au Node (proxy `/api` → 3001), et c'est le Node qui appelle tous les services Python en interne.
  - **Détection** : `find` n'a trouvé qu'un seul `docker-compose.yml` (scheduling) et aucun fichier
    Nginx ; le routage est assuré par Express + `socket.io`.
- **Authentification :** **JWT** signé par le Node.
  - HTTP : `jsonwebtoken` (`Backend/server/package.json:28`), routes/middleware dans `Backend/server/middleware/`.
  - WebSocket : middleware `io.use(...)` qui vérifie `socket.handshake.auth.token` avec
    `jwt.verify(token, process.env.JWT_SECRET_KEY)` (`Backend/server/index.js:272-315`).
    En dev, fallback « guest » ; en prod, rejet si token absent/invalide.
  - OAuth Google via `passport` + `passport-google-oauth20` (`package.json:33-34`).
- **Rate limiting :** `express-rate-limit` (`package.json:25`) ; ex. `middleware/quizRateLimit` appliqué aux soumissions de quiz (`index.js:40`).
- **CORS :** géré par Express (`cors`, `package.json:22`) **et** par Socket.IO avec une whitelist
  d'origines (`Backend/server/index.js:24-37,78-90`) : `localhost:5173/5174` + `ALLOWED_FRONTEND_URLS`.
- **Routage WebSocket :** intégralement dans le Node via Socket.IO (`path: "/socket.io/"`,
  transports `websocket`+`polling`, `index.js:78-94`). Voir section 5.
- **Documentation API :** Swagger (`swagger-jsdoc` + `swagger-ui-express`, `package.json:40-41`).

---

## 4. Bases de données et stockage

### MongoDB
- **Base :** `ai_recruiter` (partagée par tous les services).
  - Node : `MONGO_URI=mongodb://localhost:27017/ai_recruiter` (`.env.example:7`), connexion
    `mongoose.connect(process.env.MONGO_URI)` (`Backend/server/index.js:3021`).
  - Scheduling : `mongodb_database = "ai_recruiter"` (`Backend/scheduling/app/config.py:21`), driver **pymongo** (`repositories/interview_schedule_repository.py:5`).
  - Analysis : `MONGO_DB_NAME = "ai_recruiter"` (`Backend/analysis_service/app/core/config.py:27`), driver **pymongo** (`app/db/mongo.py:2-5`).
- **Driver :**
  - **mongoose 8** côté Node (`package.json:29`).
  - **pymongo** côté Python (scheduling + analysis). Le `voice_engine/requirements.txt` liste aussi `pymongo>=4.6.0`.
  - **NON TROUVÉ** : aucun usage de `motor` (driver async).
- **Modèles Mongoose** (`Backend/server/models/`) :
  `Application.js`, `CallRoom.js`, `CandidateQuiz.js`, `ComparisonReport.js`, `JobInterviewRoom.js`,
  `Message.js`, `Quiz.js`, `QuizResultModel.js`, `candidat.js`, `companyContext.js`, `department.js`,
  `interview.js`, `job.js`, `linkedinSchema.js`, `user.js`.
- **Collections utilisées par l'Analysis Service** (`Backend/analysis_service/app/db/mongo.py:7-12`) :
  `video_analysis_jobs`, `post_interview_vision_events`, `interview_transcripts`,
  `interview_final_reports`, `callrooms`, `interview_pipeline_snapshots`.

### Redis
- **Usages :**
  - **Interview Agent** : état de session d'entretien (IRT-aware). `redis.asyncio` connecté à
    `REDIS_URL` (`redis://localhost:6379`) au startup ; **fallback in-memory** si Redis indisponible
    (`Backend/voice_engine/interview_agent/agent_server.py:44-59` : `_redis = None  # graceful degradation`).
  - **Analysis Service** : files de jobs via **RQ (Redis Queue)** — queues `high/default/low`,
    `REDIS_URL=redis://localhost:6379/0` (`app/workers/queue_config.py:32`), connexion **lazy** qui
    renvoie `None` si Redis absent (`queue_config.py:38-41`). Worker : `rq worker high default low`.
  - Dépendances : `redis>=4.2.0` (`voice_engine/requirements.txt`), `redis>=5.0` + `rq>=1.15` (`analysis_service/requirements.txt`).
- **TTL / clés exactes :** **NON TROUVÉ** explicitement dans les fichiers inspectés (les clés sont
  gérées dans `interview_agent/interview_service.py` et le module `workers` ; valeurs de TTL non relevées).
- **Fallback :** **OUI**, présent pour les deux usages (in-memory pour l'agent, dégradation gracieuse pour les queues).

### Stockage de fichiers
- **Disque local uniquement.** **NON TROUVÉ** de S3 / MinIO / boto3 / aws-sdk (grep négatif sur
  `boto3|aws-sdk|S3|minio`).
- Upload via **multer** (`Backend/server/package.json:30`), middleware `middleware/uploadCV`.
- Dossiers locaux : `Backend/server/uploads/`, `uploadsPics/`, `voice-recordings/`, plus `uploads/`
  à la racine. Le Node écrit les WAV d'entretien et expose `/api/voice/download/:file` avec des
  « buckets » logiques `uploads` / `recordings` (`Backend/server/index.js:243-269,1565-1570`).
- CV / PDF générés : `pdfkit` côté Node (`package.json:35`) ; rapports/transcripts écrits sur disque
  par le voice_engine et l'analysis_service.

---

## 5. Communication inter-services et protocoles

### Appels sortants du Node (REST) vers les services Python
(sources : `Backend/server/index.js`, `routes/`, `services/`)

| Appelant | Cible | Endpoint | Rôle |
|----------|-------|----------|------|
| Node | Quiz Gen (5003) | `POST http://localhost:5003/generate-quiz` (`index.js:2068,5706`) ; `/adaptive-next-page` (`index.js:5842`) | Génération de quiz |
| Node | Parseur CV (5002) | `POST http://127.0.0.1:5002/upload` (`index.js:3495,3985`) | Parsing CV |
| Node | Recommendation (5001) | `POST http://127.0.0.1:5001/recommend` (`routes/recommendationRoute.js:7`) ; `POST /refresh-index` (`index.js:4384`, `routes/jobRoute.js:9`, `jobWizardRoute.js:94`) | Matching / recommandation |
| Node | Interview Score (7000) | `POST http://localhost:7000/predict` (`index.js:6924`) | Score d'entretien |
| Node | Hiring Model (5000) | `POST http://localhost:5000/predict-from-skills` (`index.js:7034`) | Prédiction d'embauche |
| Node | Interview Agent (8013) | `POST /session/start`, `/session/turn`, `/session/switch`, `/session/end`, `/comparison/rank` (`services/interviewAgentService.js`, agent endpoints `agent_server.py:183-243`) | Agent d'entretien adaptatif |
| Node | Speech Stack (8012) | TTS via `requestSpeechStackTts` → `POST /api/tts` (`services/speechStackService.js`, `api_server.py:614`) | Synthèse vocale de l'agent |
| Node | Face Verify (8011) | `FACE_VERIFY_SERVICE_URL` (`services/faceVerifyService.js:10`) | Vérification d'identité |
| Node | YOLO (8001) | `POST http://localhost:8001/detect-frame` (`services/yoloVisionService.js:12`, `app.py:365`) | Détection objets/intégrité |
| Node (sous-process) | Voice Engine | spawn de `realtime_worker.py` / analyse WAV (`services/voiceEngineService.js`) | STT temps réel + analyse audio |

> Le **Scheduling Service (5004)** appelle le Node en retour : `NODE_BACKEND_URL=http://node-backend:3001`
> (`Backend/scheduling/docker-compose.yml`). Il existe une route Node `routes/schedulingInternalRoute.js`
> pour les callbacks internes.

### Endpoints WebSocket (Socket.IO, Node, `Backend/server/index.js`)
- **Messagerie** : `send-message` / `receive-message` (relais temps réel ; persistance via HTTP `/api/messages/send`) (`index.js:347-351`).
- **Entretien** : `join-interview` / `leave-interview`, `user-connected/disconnected` (`index.js:353-372`).
- **Salles d'appel (call-room)** : `subscribe-to-available-rooms`, `join-room`, `call-room-created`,
  `call-room-join-request`, `confirm-candidate-join`, `reject-candidate-join`, `end-call-room`,
  `update-call-transcription` / `transcription-update`, `candidate:draft`, `call-room-status-update`
  (`index.js:374-487`).
- **Agent d'entretien adaptatif** : `agent:start-session`, `agent:candidate-turn`, `agent:switch-phase`,
  `agent:end-session` → diffuse `agent:message`, `agent:thinking`, `agent:tts`, `agent:tts-unavailable`,
  `agent:score`, `agent:error`, `agent:ended`, `candidate:message` (`index.js:770-1243`).
- **Streaming vocal (STT temps réel)** : `voice-stream:start` / `voice-stream:chunk` / `voice-stream:stop`
  → `voice-stream:partial`, `voice-stream:result`, `voice-stream:chunk-ack`, `voice-stream:error`,
  `voice-stream:worker-ready` (`index.js:1247-1654`). Les chunks audio sont poussés vers le
  worker `realtime_worker.py` (faster-whisper).
- **WebRTC** : signalisation/relais média via `Backend/server/webrtc.js` + `socket.js` (lib `wrtc`).

### File de messages
- **RabbitMQ / Kafka / Celery : NON TROUVÉ.**
- En revanche, **RQ (Redis Queue)** est utilisé par l'Analysis Service comme file de tâches
  (`Backend/analysis_service/app/workers/`, queues `high/default/low`). C'est le seul système de
  file de messages détecté.

---

## 6. Services externes / APIs tierces

| Service externe | Usage | Provider/Modèle | Fichier source |
|-----------------|-------|-----------------|----------------|
| **Groq (LLM)** | Tours d'entretien live de l'agent (faible latence) | `openai/gpt-oss-120b` (`.env.example:80`), endpoint `https://api.groq.com/openai/v1` | `Backend/voice_engine/interview_agent/llm_client.py:250` ; config `.env.example:76-87` |
| **NVIDIA NIM (LLM)** | Fallback LLM + comparaison de candidats + polish de rapport | `meta/llama-3.3-70b-instruct` (`.env.example:91`), `https://integrate.api.nvidia.com/v1` | `llm_client.py:318` ; `Backend/server/services/candidateComparisonService.js:200,383` |
| **Anthropic Claude** | Provider LLM optionnel de l'agent | SDK `anthropic` | `Backend/voice_engine/interview_agent/llm_client.py:162-165` ; `requirements.txt` (`anthropic>=0.40.0`) |
| **OpenAI** | SDK présent côté Node (provider compatible) | SDK `openai` | `Backend/server/package.json:32` ; provider `openai` listé dans `llm_client.py` |
| **Ollama (LLM local)** | Provider LLM local optionnel | `/api/chat` | `llm_client.py:132` |
| **Google Gemini** | (a) polish du rapport post-entretien ; (b) génération de contenu (job wizard, suggestions) ; (c) Vision LLM ; (d) comparaison candidats | `gemini-2.5-flash-lite` / `gemini-2.0-flash` / `gemini-1.5-flash` | `.env.example:67-99` ; `Backend/server/services/geminiContentService.js:59` (`https://generativelanguage.googleapis.com/v1beta/...`) ; `services/visionLLMService.js:4` |
| **OpenAI Whisper / faster-whisper** | STT (transcription) — **implémentation locale faster-whisper**, pas l'API OpenAI | `faster-whisper` | `Backend/voice_engine/requirements.txt` ; `speech_stack/api_server.py` ; `realtime_worker.py` |
| **edge-tts** | Synthèse vocale (TTS) de l'agent | Microsoft Edge TTS (local/cloud gratuit) | `Backend/voice_engine/speech_stack/api_server.py:9` ; `Backend/server/services/edgeTtsService.js` |
| **Google Calendar API** | Création/gestion d'événements d'entretien | OAuth2 ; `GOOGLE_CLIENT_ID/SECRET`, redirect `http://localhost:5004/auth/google/callback` | `Backend/scheduling/app/services/google_calendar_service.py` ; config `.env.example:17-21`, `scheduling/app/config.py:32` |
| **SMTP / Email** | Emails de décision candidat, notifications de planification | `smtp.gmail.com:587` (nodemailer côté Node, `service:"gmail"`) + service email Python | `Backend/server/index.js:1680-1687` (nodemailer) ; `Backend/scheduling/app/services/email_service.py` ; `.env.example:23-29` |
| **SendGrid** | Alternative email (clé prévue) | `SENDGRID_API_KEY` | `.env.example:31-32` — **clé présente mais usage code NON TROUVÉ** |
| **Apify** | Enrichissement de profils LinkedIn (scraping via actor) | `https://api.apify.com/v2`, `APIFY_ACTOR_ID`, `APIFY_TOKEN` | `Backend/server/services/linkedinApifyService.js:4` ; route `routes/linkedinEnrichRoute.js` |
| **Google OAuth (login)** | Authentification utilisateurs | `passport-google-oauth20`, `@react-oauth/google` | `Backend/server/package.json:33-34` ; `Frontend/package.json:33` |

> Détails LLM agent : variable `LLM_PROVIDER` (`groq | nvidia | anthropic | openai | ollama | echo`,
> `.env.example:75-76`) ; le « report polish » a son propre `REPORT_POLISH_PROVIDER`
> (`gemini | nvidia | anthropic | openai | ollama | echo`, `.env.example:66-67`).

---

## 7. Bibliothèques IA / ML / Vision détectées

**Voice Engine** (`Backend/voice_engine/requirements.txt`) :
`numpy`, `soundfile`, `sounddevice`, `resampy`, `torch`, `torchaudio`, **`faster-whisper`** (STT),
**`pyannote.audio`** (diarisation), **`silero-vad`** (VAD), `redis>=4.2.0`, `pymongo>=4.6.0`.

**Speech Stack** (`Backend/voice_engine/speech_stack/requirements.speech_stack.txt`) :
`transformers==4.41.2`, `torch==2.5.1`, `torchaudio==2.5.1`, `numpy==1.26.4`, `pandas==1.5.3`,
**`TTS>=0.22.0`** (Coqui TTS), `faster-whisper`, `pydub`, `httpx`. (edge-tts importé dans `api_server.py`.)

**Interview Agent** (`Backend/voice_engine/interview_agent/requirements.txt`) :
`fastapi`, `uvicorn[standard]`, `pydantic>=2.5`, `httpx`, `python-dotenv`, **`anthropic>=0.40.0`**.
(Moteur IRT maison : `irt_engine.py`.)

**Analysis Service** (`Backend/analysis_service/requirements.txt`) :
`fastapi`, `uvicorn`, `pymongo`, `opencv-python`, **`faster-whisper`**, **`ultralytics`** (YOLO),
**`langgraph>=0.2`** (pipeline de rapport), `httpx`, **`xgboost`**, **`scikit-learn`**, `redis>=5.0`,
**`rq>=1.15`**, `PyJWT`, `prometheus-client`, `websockets`, **`fer`** (emotion, optionnel),
**`mediapipe`**, **`deepface>=0.0.93`** (optionnel), `tf-keras`, **`py-feat>=0.6.0`** (FACS Action Units, optionnel),
`torch>=2.0.0`, `torchvision>=0.15.0`.

**Face Verification** (`Backend/face_verification_service/requirements.txt`) :
`flask`, `flask-cors`, **`insightface>=0.7.3`**, **`onnxruntime>=1.17.0`**, `opencv-python-headless`,
`Pillow`, `requests`, `numpy`. (Pack de modèles `buffalo_l`, `.env.example:106`.)

**YOLO Service** (`Backend/yolo-service/requirements.txt`) :
`fastapi`, `uvicorn`, **`ultralytics>=8.0.200`** (YOLOv8, poids `yolov8n.pt`), `opencv-python`, `pillow`, `numpy`, `python-multipart`, `pydantic`.

**AI classique** (`Backend/server/AI/requirements.txt`) :
`flask`, `flask-cors`, **`spacy`**, **`pdfplumber`**, `numpy`, **`pymupdf`** (fitz),
**`scikit-learn==1.6.1`**, **`paddleocr==2.7.3`**, **`paddlepaddle==2.6.2`**, `chardet`, `requests`, `python-dotenv`.
Modèles `.pkl` présents : `hiring_model.pkl`, `clustering_model.pkl`, `interview_score_model.pkl`, `scaler.pkl`.

> **NON TROUVÉ** dans les requirements inspectés : `sentence-transformers`, `faiss`, `langchain`
> (seul **`langgraph`** est présent côté analysis_service). Le matching de l'IA recommendation repose sur
> scikit-learn / TF-IDF, pas sur faiss.

---

## 8. Infrastructure

### docker-compose.yml
- **Un seul `docker-compose.yml`** trouvé : `Backend/scheduling/docker-compose.yml`.
  - `scheduling-service` : build local (Dockerfile), port **5004:5004**, env `MONGODB_URL=mongodb://mongo:27017`,
    `MONGODB_DATABASE=ai_recruiter`, `NODE_BACKEND_URL=http://node-backend:3001`, `depends_on: [mongo]`,
    réseau `ai-recruiter-network`, volume `./:/app`.
  - `mongo` : image **`mongo:6.0`**, port **27017:27017**, `MONGO_INITDB_DATABASE=ai_recruiter`,
    volume `mongo_data:/data/db`.
  - **NON TROUVÉ** : pas de compose orchestrant le Node, le frontend, ni les autres services Python
    (Node `node-backend:3001` est référencé en env mais n'est pas défini comme service dans ce compose).

### Dockerfiles
- **Un seul Dockerfile** : `Backend/scheduling/Dockerfile` — base `python:3.11-slim`, installe `requirements.txt`,
  expose **5004**, healthcheck `requests.get(http://localhost:5004/health)`, `CMD ["python", "main.py"]`.
- **NON TROUVÉ** : aucun Dockerfile pour le Node, le frontend, l'analysis_service, le voice_engine,
  le face/yolo service. Ces services sont lancés en local via scripts PowerShell/BAT (voir ci-dessous).

### Lanceurs locaux (orchestration réelle hors Docker)
- `START_CALLROOM.bat` → `Backend/scripts/run_call_room_full_stack.ps1` : démarre Node 3001, Frontend 5173,
  Speech 8012, Agent 8013, Analysis 8090, YOLO 8001, Face 8011, avec health-checks `/health`.
- `Backend/voice_engine/scripts/run_voice_interview_stack.ps1` : démarre Speech 8012 + Interview Agent 8013.
- `Backend/server/AI/start_all_ai.bat` / `start_all_ai.py` : démarre les 6 micro-services Flask (5000/5001/5002/5003/5006/7000).
- Environnement Python : `.venv` partagée, `PYTHONHOME=...Python314`, `PYTHONUTF8=1`.

### CI/CD
- **Jenkins** : `Jenkinsfile` à la racine — stages `Install Dependencies` (`npm install`),
  `Unit Tests` (`npm test`), `Build Application` (`npm run build`). Pipeline orienté Node/frontend uniquement.
- **GitHub Actions : NON TROUVÉ** (pas de dossier `.github/workflows`).

---

## 9. Tableau récapitulatif

| Service | Techno | Port | Rôle | Communique avec | Base/Stockage |
|---------|--------|------|------|-----------------|---------------|
| Node backend / API | Node.js + Express 4 + Socket.IO | 3001 | API REST + WebSocket + WebRTC, auth JWT, orchestration | Frontend (REST/WS), tous les services Python (REST), Scheduling (callback) | MongoDB `ai_recruiter` (mongoose), disque local (`uploads/`) |
| Frontend principal | React 19 + Vite 6 | 5173 | SPA front+back office | Node (REST `/api`, Socket.IO, WebRTC) | — |
| Frontend login | React + Vite | 5174 | Portail de login | Node | — |
| Scheduling | Python + FastAPI | 5004 | Planification entretiens, Google Calendar, emails | Node (`/api/scheduling/...`), Google Calendar, SMTP | MongoDB `ai_recruiter` (pymongo) |
| Analysis Service | Python + FastAPI + LangGraph | 8090 | Rapport post-entretien, vision/comportement, ranking, ATS | Node (REST), Gemini/NVIDIA (polish) | MongoDB (collections vidéo/rapports), Redis (RQ) |
| Interview Agent | Python + FastAPI | 8013 | Agent d'entretien adaptatif (IRT), scoring | Node (REST), Groq/NVIDIA/Anthropic/Ollama (LLM) | Redis (état session, fallback in-memory) |
| Speech Stack | Python + FastAPI | 8012 | STT (faster-whisper) + TTS (edge-tts/Coqui) + sentiment | Node (REST `/api/tts`, `/api/transcribe`) | Disque local (audio temp) |
| Face Verification | Python + Flask | 8011 | Vérification d'identité (InsightFace) | Node (REST) | Modèles ONNX `buffalo_l` |
| YOLO Vision | Python + FastAPI | 8001 | Détection objets/personnes (intégrité) | Node (REST `/detect-frame`) | Poids `yolov8n.pt` |
| Voice Engine (worker) | Python | sous-process | STT temps réel + diarisation | Node (spawn/stdin-stdout) | Disque local (WAV/PDF/TXT) |
| AI — Parseur CV | Python + Flask | 5002 | Parsing CV (spaCy/PaddleOCR) | Node (`/upload`) | Disque local |
| AI — Hiring Model | Python + Flask | 5000 | Prédiction d'embauche | Node (`/predict-from-skills`) | `hiring_model.pkl` |
| AI — Recommendation | Python + Flask | 5001 | Matching / recommandation jobs | Node (`/recommend`, `/refresh-index`) | index en mémoire |
| AI — Interview Score | Python + Flask | 7000 | Score d'entretien | Node (`/predict`) | `interview_score_model.pkl` |
| AI — Clustering | Python + Flask | 5006 | Clustering candidats | Node | `clustering_model.pkl` |
| AI — Quiz Generation | Python + Flask | 5003 | Génération de quiz adaptatifs | Node (`/generate-quiz`, `/adaptive-next-page`) | — |
| MongoDB | MongoDB 6.0 | 27017 | Base partagée | Node, Scheduling, Analysis | `mongo_data` volume |
| Redis | Redis | 6379 | État sessions agent + files RQ analysis | Interview Agent, Analysis Service | — |

---

### Notes & angles morts (transparence)
- Le **port 5174** du frontend login provient de `.env.example` ; le `vite.config.js` du login ne le fixe
  pas explicitement (port non relu dans ce fichier) → à confirmer.
- Les **clés/TTL exacts de Redis** ne sont pas listés ici (logique dans `interview_service.py` /
  `workers/`, non détaillée) → **NON TROUVÉ** au niveau du détail demandé.
- **SendGrid** : clé d'env présente, mais aucun appel SDK trouvé dans le code inspecté.
- Aucune **gateway** ni **service mesh** ; l'« API gateway » de fait est le serveur Node Express.
- Aucun **Dockerfile** pour la majorité des services : l'orchestration de production réelle se fait via
  scripts Windows (PowerShell/BAT), pas via Docker (sauf scheduling + mongo).
