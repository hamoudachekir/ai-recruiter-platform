# CV Tailoring Premium

Reformulates a candidate's parsed CV for a specific job (Groq), verifies no facts were
invented (spaCy), renders a PDF via a **self-hosted** Reactive Resume, and attaches the
tailored CV to the Application.

## Services & ports
- `cv-tailoring-service` (FastAPI) — 8014
- CV parser (existing) — 5002
- Node gateway — 3001
- Reactive Resume (Docker) — app 3000, Postgres (internal), MinIO 9000, headless Chrome (internal)
- MongoDB — 27017

## Run
```bash
# 1) Reactive Resume (self-hosted; RGPD — never the public cloud)
docker compose -f docker-compose.rxresume.yml up -d
#    First boot: open http://localhost:3000 and create an account (any email/password —
#    this instance is local-only). v4.4.6 has NO API-key setting; the service
#    authenticates by logging in with that account's email/password.
#    Put those credentials in Backend/cv_tailoring_service/.env as
#    RXRESUME_EMAIL / RXRESUME_PASSWORD.

# 2) cv-tailoring-service (use the same venv as Backend/server/AI)
cd Backend/cv_tailoring_service
cp .env.example .env   # fill GROQ_API_KEY, RXRESUME_EMAIL, RXRESUME_PASSWORD
pip install -r requirements.txt
python -m uvicorn app.main:app --port 8014

# 3) Node gateway already knows CV_TAILORING_SERVICE_URL from Backend/server/.env
```

## Environment
| Var | Where | Meaning |
|-----|-------|---------|
| `GROQ_API_KEY` | cv-tailoring `.env` | Groq key (LLM) |
| `GROQ_MODEL` | cv-tailoring `.env` | `openai/gpt-oss-120b` |
| `RXRESUME_URL` | cv-tailoring `.env` | `http://localhost:3000` (local only) |
| `RXRESUME_EMAIL` / `RXRESUME_PASSWORD` | cv-tailoring `.env` | account created on the local instance — used to log in (no API-key concept in v4.4.6) |
| `MONGO_URI` | cv-tailoring `.env` | `mongodb://localhost:27017/ai_recruiter` |
| `CV_PARSER_URL` | cv-tailoring `.env` | `http://127.0.0.1:5002` |
| `TAILORED_CV_UPLOAD_DIR` | cv-tailoring `.env` | `Backend/server/uploads/tailored-cvs` |
| `CV_TAILORING_SERVICE_URL` | `Backend/server/.env` | `http://localhost:8014` |

## Endpoints
- `POST /api/cv/tailor` `{ jobId }` → tailored JSON + changes + verification (fast, no PDF)
- `POST /api/cv/tailor/export` `{ jobId, cv_json, tailored_cv_json, attach }` → `{ pdf_path, attached }`
- `GET /api/cv/tailored/:applicationId` → tailored CV (candidate or enterprise)

## Reactive Resume integration notes (confirmed against a live v4.4.6 instance)

No official docs matched this exact version; the real behavior, confirmed by hand:

- **Auth**: no API-key setting exists. `POST /api/auth/login {identifier, password}` sets
  httpOnly `Authentication`/`Refresh` cookies, replayed on later requests.
- **Create**: `POST /api/resume {title, slug}` — any `data` in the body is **ignored**; the
  response always contains a fresh default `data` skeleton. This means creating a resume
  doubles as fetching the base skeleton — no separate "probe" resume needed.
- **Update**: `PATCH /api/resume/{id} {data}` applies our mapped content.
- **Export**: `GET /api/resume/print/{id}` synchronously renders and returns `{url}` — a
  direct link into the storage backend (MinIO), not proxied through the app.
- **Storage**: `STORAGE_URL` must be the real, publicly reachable MinIO endpoint (e.g.
  `http://localhost:9000/default`), not a path on the Reactive Resume app itself — the
  app returns `${STORAGE_URL}/<path>` directly to the caller. MinIO's port must be
  published to the host (`docker-compose.rxresume.yml` does this).
- **Item schema** (`app/mapping.py`): confirmed via `GET /api/resume/schema` — sections
  are `{id, name, items, columns, visible, separateLinks}` (not `title`/`icon`/`hidden`,
  which is a *different* schema seen on the public rxresu.me cloud — do not mix the two).
  `summary` lives at `data.sections.summary.content`, not a top-level `data.summary`.
  `company` (experience), `institution` (education), and `name` (languages) all require a
  non-empty string server-side; `mapping.py` substitutes a placeholder rather than send `""`.
- Item `id` must match `^[0-9a-z]+$` (Cuid2-like) — `uuid.uuid4().hex` satisfies this.
