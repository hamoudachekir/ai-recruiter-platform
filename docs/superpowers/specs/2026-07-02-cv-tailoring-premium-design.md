# CV Tailoring Premium (côté Candidat) — Design Spec

- **Status:** Draft — awaiting user review
- **Date:** 2026-07-02
- **Author:** NextHire team (via Claude)
- **Scope:** One feature, one implementation plan.

---

## 1. Objective

Premium candidate feature: reformulate an existing CV to align it with a specific Job
Description (JD). The tailored CV:

- keeps **all factual information intact** (companies, dates, degrees, figures);
- adapts only vocabulary, phrasing, and section ordering to the JD;
- **never invents** a skill or experience absent from the original CV.

The tailored CV (PDF + JSON) is attached to the candidate's **Application** so the recruiter
sees it when the candidate applies.

## 2. Confirmed decisions (from brainstorming)

| Question | Decision |
|---|---|
| Source of `cv_json` | **Full re-parse** of the candidate's uploaded CV PDF via the existing parser (`127.0.0.1:5002/upload`) at tailoring time — recovers education, which `user.profile` drops. |
| Reactive Resume target | **Local self-hosted instance only** (`RXRESUME_URL`, default `http://localhost:3000`). RGPD: candidate CVs never leave our infra. Public cloud `rxresu.me` is **not** used in production. |
| Orchestration / UX | **Two-phase (A):** `/tailor` returns JSON + changes fast for live preview; `/export-pdf` generates+saves the PDF only on "Télécharger PDF" / "Utiliser ce CV". |
| Attachment | Tailored CV attached to the **Application** document; entry point = **job detail page** (`/job/:id`). |
| Premium gating | **None for now.** "✨ Premium" badge is cosmetic. No `User` migration, no upsell modal, no flag checks. Gating can be added later. |

## 3. Constraints & non-goals

- **Reuse the existing stack.** Python/FastAPI microservice; scikit-learn TF-IDF (already
  present in `Backend/server/AI`); spaCy NER (already used by the CV parser); Groq
  `openai/gpt-oss-120b` (already configured, supports `schema_strict`); MongoDB `ai_recruiter`
  (pymongo); local disk via the existing Multer-served `uploads/` tree.
- **Do NOT introduce:** S3/MinIO, Sentence-Transformers, FAISS, LangChain.
- **Do NOT** send any data to the public cloud `rxresu.me` — local instance only.
- **No new premium/subscription model** in this iteration.

## 4. Architecture & data flow

```
Frontend (JobDetails /job/:id, :5173)
  ① POST /api/cv/tailor { jobId }                         (auth: candidate)
  ▼
Express gateway (:3001)
  routes/cvTailoringRoute.js + services/cvTailoringService.js
    a. load User(candidateId); resolve original CV file from user.profile.resume on disk
    b. stream file → POST 127.0.0.1:5002/upload → internal cv_json (incl. education)
    c. POST {CV_TAILORING_SERVICE_URL}/tailor { candidate_id, cv_json, job_id }
  ▼
cv-tailoring-service (FastAPI, :8014)
    1. fetch JD from Mongo `jobs` by _id (pymongo)
    2. TF-IDF keyword extraction from JD (scikit-learn)
    3. Groq openai/gpt-oss-120b (schema_strict) → tailored internal JSON + changes_applied[]
    4. spaCy NER anti-hallucination (ORG / DATE / CARDINAL / degree+number regex):
       reject + re-prompt once on invented entity; else return 422
    5. return { tailored_cv_json, changes_applied[], verification }
  ◄──────────────────────────────────────────────────────────
Express → Frontend: LIVE PREVIEW (right column) + changes panel + "✅ vérifié" badge

  ② POST /api/cv/tailor/export { jobId, tailored_cv_json }   (on Download / Use)
  ▼
Express → POST {CV_TAILORING_SERVICE_URL}/export-pdf
  ▼
cv-tailoring-service → rxresume_client.py
    - schema-probe: GET a fresh resume from the instance; assert container keys
    - map internal → RxResume `data` (mapping.py)
    - POST {RXRESUME_URL}/api/openapi/resumes (header x-api-key)
    - trigger export → download PDF → save to {TAILORED_CV_UPLOAD_DIR}
    - return { pdf_path, resume_id }
  ◄──
Express: on "Utiliser ce CV" → upsert Application(candidate+job) with tailored fields
```

## 5. File plan

### 5.1 Create — Python service `Backend/cv_tailoring_service/`

Runs on the **same interpreter/venv as `Backend/server/AI`** (already has `spacy` +
`scikit-learn`), so only FastAPI/uvicorn/httpx/groq/pymongo/python-dotenv are added.

| File | Responsibility |
|---|---|
| `app/main.py` | FastAPI app; routes `GET /health`, `POST /tailor`, `POST /export-pdf`. |
| `app/schema.py` | Pydantic models: internal `cv_json`, `TailorRequest`, tailored output, `ExportRequest`, responses. |
| `app/db.py` | pymongo connection to `ai_recruiter`; `get_job(job_id)`. |
| `app/keywords.py` | TF-IDF JD keyword/skill extraction (scikit-learn). |
| `app/llm.py` | Groq client, system prompt, `schema_strict` call, one-retry hook. |
| `app/anti_hallucination.py` | spaCy NER entity extraction + diff (original vs tailored); verdict + offending entities. |
| `app/mapping.py` | Internal tailored JSON → RxResume `data` object (single source of truth). |
| `app/rxresume_client.py` | Schema-probe, create resume, export, download PDF, save to disk, error handling. |
| `requirements.txt` | Added deps only. |
| `.env.example` | `RXRESUME_URL`, `RXRESUME_API_KEY`, `GROQ_API_KEY`, `GROQ_MODEL`, `MONGO_URI`, `CV_PARSER_URL`, `TAILORED_CV_UPLOAD_DIR`. |
| `README.md` | Run service, env vars, RxResume API-key generation. |

### 5.2 Create — Express (Node)

| File | Responsibility |
|---|---|
| `Backend/server/routes/cvTailoringRoute.js` | `POST /api/cv/tailor`, `POST /api/cv/tailor/export`, `GET /api/cv/tailored/:applicationId`. |
| `Backend/server/services/cvTailoringService.js` | Orchestration: resolve CV file, call parser, call 8014, persist to Application. |

### 5.3 Create — Frontend `Frontend/src/pages/CvTailoring/`

| File | Responsibility |
|---|---|
| `TailorCvButton.jsx` | "Adapter mon CV à cette offre ✨" button + cosmetic Premium badge; mounts panel. |
| `TailorCvPanel.jsx` | Left: original preview · center: changes list + "✅ Aucune information inventée — vérifié" · right: tailored live preview · actions: Régénérer / Télécharger PDF / Utiliser ce CV. Loading states for LLM + PDF phases. |
| `cvTailoringApi.js` | Axios calls to the three endpoints. |

### 5.4 Create — Infra / docs

| File | Responsibility |
|---|---|
| `docker-compose.rxresume.yml` (repo root) | `reactive-resume` (**pinned** image tag/digest — not `:latest`) + dedicated Postgres + persistent volume. |
| `docs/cv-tailoring/README.md` | Launch service + RxResume, env vars, API-key generation (dashboard → Settings → API Keys). |

### 5.5 Modify

| File | Change |
|---|---|
| `Backend/server/models/Application.js` | Add `tailoredCvPath`, `tailoredCvJson` (Mixed), `tailoredCvChanges` ([String]), `tailoredCvGeneratedAt` (Date). |
| `Backend/server/middleware/auth.js` | Add `requireCandidate` (sibling of `requireEnterprise`). |
| `Backend/server/index.js` | Mount `cvTailoringRoute`; ensure `uploads/tailored-cvs/` exists (served by existing `/uploads` static). |
| `Frontend/src/pages/JobDetails/JobDetails.jsx` | Mount `TailorCvButton`. |
| `Backend/server/.env` (+ root `.env`) | `CV_TAILORING_SERVICE_URL=http://localhost:8014`. |
| `.env.example` | Placeholders for all new vars. |

## 6. Data model change (Application)

```js
tailoredCvPath:        { type: String, default: null },   // "/uploads/tailored-cvs/<file>.pdf"
tailoredCvJson:        { type: mongoose.Schema.Types.Mixed, default: null },
tailoredCvChanges:     [{ type: String }],
tailoredCvGeneratedAt: { type: Date, default: null },
```

`GET /api/cv/tailored/:applicationId` returns `{ tailoredCvPath, tailoredCvJson,
tailoredCvChanges, tailoredCvGeneratedAt }` — readable by both the owning candidate and the
job's enterprise.

## 7. Internal schemas

### 7.1 `cv_json` (parser output — internal NextHire shape)

```
{ name, email, phone, role, domain,
  profile: { resume(summary text), shortDescription, skills[str], phone,
             languages[str], availability, domain,
             experience: [{ title, company, duration, description }] },
  education: [ str, ... ] }        // flat raw lines (parser is unstructured)
```

### 7.2 Tailored output (LLM, `schema_strict`)

```
{ summary: str,
  experiences: [{ title, company, duration, description }],  // text reformulated, facts intact
  skills: [str],                                             // reordered / rephrased
  education: [str],                                          // reordered only (factual)
  changes_applied: [str] }
```

## 8. LLM system prompt (Groq `openai/gpt-oss-120b`, schema_strict)

```
Tu es un assistant de reformulation de CV. On te donne un CV au format JSON et la liste des
exigences clés d'une offre d'emploi. Ta tâche : reformuler le CV pour mieux correspondre à l'offre.

RÈGLES STRICTES :
1. N'ajoute AUCUNE compétence, expérience, diplôme ou certification absente du CV original.
2. Garde INTACTS : noms d'entreprises, dates, intitulés de diplômes, chiffres et résultats.
3. Tu peux : reformuler les descriptions, réordonner compétences/expériences par pertinence,
   adapter le vocabulaire à celui de l'offre, mettre en avant ce qui correspond.
4. Rédige dans la même langue que le CV original.
5. Réponds UNIQUEMENT en JSON conforme au schéma fourni, sans texte autour.
```

## 9. Anti-hallucination

Extract entity sets from **original** `cv_json` vs **tailored** output with spaCy
(`ORG`, `DATE`, `CARDINAL`/`PERCENT`) plus a degree/number regex (diplomas & figures).
Normalize (lowercase, trim, strip punctuation) before comparison. Any factual entity present
in the tailored CV but **absent** from the original ⇒ reject, re-prompt Groq once naming the
offending entities; if it still fails, return `422` with the offending list (no silent PDF).
Reordering / rephrasing of existing skills is allowed.

`verification = { passed: bool, invented_entities: [str], retried: bool }`.

## 10. Reactive Resume integration

### 10.1 Version pinning

`docker-compose.rxresume.yml` pins a **specific image tag/digest** (not `:latest`) so the
`data` schema is frozen and matches `mapping.py`. The public cloud `rxresu.me` already runs a
newer, divergent schema; pinning locally avoids that drift.

### 10.2 Mapping — internal → RxResume `data`

**Container level (CONFIRMED** from a live GET on the user's instance — resume object is
`{ id, name, slug, tags, isPublic, data:{...}, ... }`; `data` = `picture`, `basics`, `summary`
(top-level), `sections.{profiles,experience,education,skills,languages,...}` each
`{title, icon, columns, hidden, items:[]}`, `customSections`, `metadata`):

Base = clone a fresh resume's `data` from the instance, then populate:

| Internal (tailored) | → `data` target | Notes |
|---|---|---|
| `cv.name` | `basics.name` | factual, untouched |
| `cv.email` / `cv.phone` | `basics.email` / `basics.phone` | untouched |
| `cv.profile.domain` | `basics.headline` | fallback: first experience title |
| `tailored.summary` | `summary.content` | HTML-wrapped rich text |
| `tailored.experiences[]` | `sections.experience.items[]` | see item mapping (PROVISIONAL) |
| `tailored.education[]` (strings) | `sections.education.items[]` | raw line → item summary; structured fields empty |
| `tailored.skills[]` (strings) | `sections.skills.items[]` | name + keywords |
| `cv.profile.languages[]` | `sections.languages.items[]` | factual, untouched |
| — | `metadata` | kept from the cloned base (template, layout, typography) |

**Item level (PROVISIONAL — single open item; see §14).** Both live samples the user provided
were empty (`items:[]`), so exact item field names are not yet confirmed. Provisional target
(RxResume `data` item shape): experience `{ id, visible|hidden, company, position←title,
date←duration, location, summary←description(HTML), url }`; education `{ id, institution,
studyType, area, date, summary←raw line }`; skills `{ id, name, level, keywords[], description }`;
languages `{ id, name, level, description }`. `mapping.py` is the single place to adjust these
once a populated local export is available.

### 10.3 Schema-probe (fail-loud)

`rxresume_client.py` GETs a fresh resume at startup/first export and asserts the expected
container keys exist; on POST it validates the response. On any divergence it raises a clear
error naming the missing/renamed fields — never produces a silently broken PDF.

### 10.4 PDF export

Create resume (`POST /api/openapi/resumes`, `x-api-key`), trigger export/print, download the
PDF, save to `{TAILORED_CV_UPLOAD_DIR}` (= `Backend/server/uploads/tailored-cvs/`), return the
relative path `/uploads/tailored-cvs/<file>.pdf`. **Exact export endpoint of the pinned v4 tag
is an open item (§14).** If the instance is unreachable, return a clear error (no crash, no
partial attach).

## 11. Environment variables & placement

- **Node** loads `Backend/server/.env` (dotenv at cwd) → needs `CV_TAILORING_SERVICE_URL`.
- **Python service** loads its own `Backend/cv_tailoring_service/.env` → needs `RXRESUME_URL`,
  `RXRESUME_API_KEY`, `GROQ_API_KEY`, `GROQ_MODEL`, `MONGO_URI`, `CV_PARSER_URL`,
  `TAILORED_CV_UPLOAD_DIR`.
- `RXRESUME_API_KEY` lives only in gitignored `.env` files, read via `os.getenv`, never
  hardcoded, never committed. **The key shared in chat must be rotated** (exposed in transcript);
  the local instance issues its own key anyway (the cloud key won't authenticate locally).

## 12. Error handling

- Parser (5002) down or file missing → `502` "CV source unavailable".
- Groq failure / invalid JSON → retry once, then `502`.
- Anti-hallucination fail after retry → `422` with offending entities.
- RxResume unreachable / schema mismatch → `502` with clear message; Application not mutated.
- All failures surfaced to the frontend as actionable messages; loading spinner cleared.

## 13. Testing

- Python: unit tests for `keywords`, `anti_hallucination` (invented-entity detection), `mapping`
  (golden internal→`data`), and a `rxresume_client` schema-probe test against a recorded sample.
- Express: route tests with parser + 8014 mocked (happy path, premium-badge-only, 422 passthrough,
  export attaches to Application).
- Frontend: panel renders preview + changes; loading and error states.

## 14. Open items to confirm (before the export step is finalized)

1. **Populated resume JSON from the running local instance** (one experience, one education, one
   skill, one language) → locks the item-level field names in `mapping.py` (§10.2).
2. **Exact pinned image tag/digest** for `amruthpillai/reactive-resume` used in
   `docker-compose.rxresume.yml` (§10.1).
3. **Exact v4 PDF export/print endpoint** of that pinned instance (§10.4).

These do not block building the service, the Express proxy, the anti-hallucination step, or the
frontend; they only finalize the RxResume export path, which is isolated in
`mapping.py` + `rxresume_client.py`.

## 15. Deliverables

1. `cv-tailoring-service` (FastAPI + anti-hallucination).
2. `rxresume_client.py` (mapping + API + export/download + local save).
3. `docker-compose.rxresume.yml` + API-key doc.
4. Express proxy routes (no gating; cosmetic Premium badge).
5. React tailoring UI.
6. Application MongoDB fields.
7. Short README (run, env vars, RxResume).
