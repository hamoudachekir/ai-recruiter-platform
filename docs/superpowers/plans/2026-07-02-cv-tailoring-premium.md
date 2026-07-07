# CV Tailoring Premium Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a candidate reformulate their parsed CV to a specific job (Groq LLM, anti-hallucination-checked), render it via a self-hosted Reactive Resume instance into a PDF, and attach the tailored CV (PDF + JSON) to their Application for the recruiter to see.

**Architecture:** New FastAPI microservice `cv-tailoring-service` (port 8014) does JD-keyword extraction (TF-IDF), Groq reformulation (`schema_strict`), spaCy anti-hallucination, internal→Reactive-Resume mapping, and PDF export/download/save. A thin Express proxy (port 3001) re-parses the candidate's CV via the existing parser (5002), calls 8014, and persists results on the `Application`. A React panel on the job-detail page drives the two-phase UX (fast JSON preview, then on-demand PDF).

**Tech Stack:** Python 3 / FastAPI / httpx / pymongo / scikit-learn (TF-IDF) / spaCy (`en_core_web_sm`); Node.js / Express; React 19 / Vite; Reactive Resume (self-hosted, Docker) + PostgreSQL; Groq `openai/gpt-oss-120b`.

## Global Constraints

- **Reuse the existing stack only.** No new heavyweight deps. Run the Python service on the **same venv as `Backend/server/AI`** (already has `spacy`, `en_core_web_sm`, `scikit-learn`).
- **Do NOT introduce:** S3 / MinIO, Sentence-Transformers, FAISS, LangChain.
- **RGPD:** Reactive Resume is the **local self-hosted instance ONLY** (`RXRESUME_URL`, default `http://localhost:3000`). Never call the public cloud `rxresu.me` from product code.
- **No premium gating** this iteration. The "✨ Premium" badge is cosmetic. No `User` model changes, no upsell modal, no entitlement checks.
- **LLM:** Groq `openai/gpt-oss-120b` via `POST https://api.groq.com/openai/v1/chat/completions`, `response_format` json-schema strict; validate output with Pydantic regardless.
- **Storage:** local disk only. Tailored PDFs → `Backend/server/uploads/tailored-cvs/`, served by the existing `/uploads` static route.
- **Secrets:** `RXRESUME_API_KEY` / `GROQ_API_KEY` read via `os.getenv`, only from gitignored `.env`; never hardcode, never commit.
- **Reactive Resume schema:** container shape is confirmed from a live GET (resume = `{ id, name, slug, data:{ picture, basics, summary, sections.{...}.items[], customSections, metadata } }`). **Item-level field names are PROVISIONAL** — centralized in `mapping.py` helpers, to be confirmed from one populated local export. Pin a specific image tag/digest (not `:latest`).

---

## Phase 1 — `cv-tailoring-service` (Python, FastAPI, :8014)

Working dir for Phase 1: `Backend/cv_tailoring_service/`. Run tests with the AI venv's Python.

### Task 1: Service scaffold, config, `/health`

**Files:**
- Create: `Backend/cv_tailoring_service/app/__init__.py`
- Create: `Backend/cv_tailoring_service/app/config.py`
- Create: `Backend/cv_tailoring_service/app/main.py`
- Create: `Backend/cv_tailoring_service/requirements.txt`
- Create: `Backend/cv_tailoring_service/.env.example`
- Create: `Backend/cv_tailoring_service/tests/__init__.py`
- Test: `Backend/cv_tailoring_service/tests/test_health.py`

**Interfaces:**
- Produces: `app.main:app` (FastAPI); `app.config:Settings` with attrs `rxresume_url`, `rxresume_api_key`, `groq_api_key`, `groq_model`, `groq_base_url`, `mongo_uri`, `mongo_db`, `cv_parser_url`, `tailored_cv_upload_dir`, `port`; `app.config:get_settings() -> Settings`.

- [ ] **Step 1: Write the failing test**

`Backend/cv_tailoring_service/tests/test_health.py`:
```python
from fastapi.testclient import TestClient
from app.main import app

client = TestClient(app)

def test_health_ok():
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"
    assert r.json()["service"] == "cv-tailoring-service"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd Backend/cv_tailoring_service && python -m pytest tests/test_health.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app'` / `app.main`.

- [ ] **Step 3: Create `requirements.txt`**

```
fastapi>=0.110
uvicorn[standard]>=0.29
httpx>=0.27
pymongo>=4.6
python-dotenv>=1.0
pydantic>=2.5
# scikit-learn, spacy, en_core_web_sm are already provided by the Backend/server/AI venv
```

- [ ] **Step 4: Create `.env.example`**

```
RXRESUME_URL=http://localhost:3000
RXRESUME_API_KEY=
GROQ_API_KEY=
GROQ_MODEL=openai/gpt-oss-120b
GROQ_BASE_URL=https://api.groq.com/openai/v1
MONGO_URI=mongodb://localhost:27017/ai_recruiter
MONGO_DB=ai_recruiter
CV_PARSER_URL=http://127.0.0.1:5002
TAILORED_CV_UPLOAD_DIR=../server/uploads/tailored-cvs
PORT=8014
```

- [ ] **Step 5: Create `app/__init__.py` and `tests/__init__.py`** (both empty files)

- [ ] **Step 6: Create `app/config.py`**

```python
import os
from dataclasses import dataclass
from functools import lru_cache
from dotenv import load_dotenv

load_dotenv()


@dataclass(frozen=True)
class Settings:
    rxresume_url: str
    rxresume_api_key: str
    groq_api_key: str
    groq_model: str
    groq_base_url: str
    mongo_uri: str
    mongo_db: str
    cv_parser_url: str
    tailored_cv_upload_dir: str
    port: int


@lru_cache
def get_settings() -> Settings:
    return Settings(
        rxresume_url=os.getenv("RXRESUME_URL", "http://localhost:3000").rstrip("/"),
        rxresume_api_key=os.getenv("RXRESUME_API_KEY", ""),
        groq_api_key=os.getenv("GROQ_API_KEY", ""),
        groq_model=os.getenv("GROQ_MODEL", "openai/gpt-oss-120b"),
        groq_base_url=os.getenv("GROQ_BASE_URL", "https://api.groq.com/openai/v1").rstrip("/"),
        mongo_uri=os.getenv("MONGO_URI", "mongodb://localhost:27017/ai_recruiter"),
        mongo_db=os.getenv("MONGO_DB", "ai_recruiter"),
        cv_parser_url=os.getenv("CV_PARSER_URL", "http://127.0.0.1:5002").rstrip("/"),
        tailored_cv_upload_dir=os.getenv("TAILORED_CV_UPLOAD_DIR", "../server/uploads/tailored-cvs"),
        port=int(os.getenv("PORT", "8014")),
    )
```

- [ ] **Step 7: Create `app/main.py`**

```python
from fastapi import FastAPI

app = FastAPI(title="cv-tailoring-service")


@app.get("/health")
def health():
    return {"status": "ok", "service": "cv-tailoring-service"}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `cd Backend/cv_tailoring_service && python -m pytest tests/test_health.py -v`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add Backend/cv_tailoring_service
git commit -m "feat(cv-tailoring): scaffold FastAPI service with health endpoint"
```

---

### Task 2: Pydantic schemas

**Files:**
- Create: `Backend/cv_tailoring_service/app/schema.py`
- Test: `Backend/cv_tailoring_service/tests/test_schema.py`

**Interfaces:**
- Produces: `Experience`, `CvProfile`, `CvJson`, `TailoredCv`, `Verification`, `TailorRequest`, `TailorResponse`, `ExportRequest`, `ExportResponse` (all `pydantic.BaseModel`). Field shapes exactly as below.

- [ ] **Step 1: Write the failing test**

`tests/test_schema.py`:
```python
from app.schema import CvJson, TailoredCv, TailorRequest

SAMPLE_CV = {
    "name": "Ada Lovelace", "email": "ada@x.io", "phone": "+216 20 000 000",
    "role": "CANDIDATE", "domain": "Software",
    "profile": {
        "resume": "Engineer summary", "shortDescription": "short",
        "skills": ["Python", "SQL"], "phone": "+216 20 000 000",
        "languages": ["English", "French"], "availability": "Full-time",
        "domain": "Software",
        "experience": [
            {"title": "Dev", "company": "ACME", "duration": "2020-2022", "description": "Built things"}
        ],
    },
    "education": ["BSc Computer Science, University of Tunis, 2019"],
}

def test_cvjson_parses():
    cv = CvJson.model_validate(SAMPLE_CV)
    assert cv.name == "Ada Lovelace"
    assert cv.profile.skills == ["Python", "SQL"]
    assert cv.education == ["BSc Computer Science, University of Tunis, 2019"]

def test_tailor_request_parses():
    req = TailorRequest.model_validate({"candidate_id": "c1", "job_id": "j1", "cv_json": SAMPLE_CV})
    assert req.cv_json.profile.experience[0].company == "ACME"

def test_tailored_cv_defaults_lists():
    t = TailoredCv.model_validate({"summary": "s", "experiences": [], "skills": [], "education": [], "changes_applied": []})
    assert t.changes_applied == []
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_schema.py -v`
Expected: FAIL — `ModuleNotFoundError: app.schema`.

- [ ] **Step 3: Create `app/schema.py`**

```python
from typing import List, Optional
from pydantic import BaseModel, Field


class Experience(BaseModel):
    title: str = ""
    company: str = ""
    duration: str = ""
    description: str = ""


class CvProfile(BaseModel):
    resume: str = ""
    shortDescription: str = ""
    skills: List[str] = Field(default_factory=list)
    phone: str = ""
    languages: List[str] = Field(default_factory=list)
    availability: str = "Full-time"
    domain: str = ""
    experience: List[Experience] = Field(default_factory=list)


class CvJson(BaseModel):
    name: str = ""
    email: str = ""
    phone: str = ""
    role: str = "CANDIDATE"
    domain: str = ""
    profile: CvProfile = Field(default_factory=CvProfile)
    education: List[str] = Field(default_factory=list)


class TailoredCv(BaseModel):
    summary: str = ""
    experiences: List[Experience] = Field(default_factory=list)
    skills: List[str] = Field(default_factory=list)
    education: List[str] = Field(default_factory=list)
    changes_applied: List[str] = Field(default_factory=list)


class Verification(BaseModel):
    passed: bool
    invented_entities: List[str] = Field(default_factory=list)
    retried: bool = False


class TailorRequest(BaseModel):
    candidate_id: str
    job_id: str
    cv_json: CvJson


class TailorResponse(BaseModel):
    tailored_cv_json: TailoredCv
    changes_applied: List[str]
    verification: Verification


class ExportRequest(BaseModel):
    candidate_id: Optional[str] = None
    job_id: Optional[str] = None
    cv_json: CvJson
    tailored_cv_json: TailoredCv


class ExportResponse(BaseModel):
    pdf_path: str
    resume_id: str
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_schema.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add Backend/cv_tailoring_service/app/schema.py Backend/cv_tailoring_service/tests/test_schema.py
git commit -m "feat(cv-tailoring): add pydantic schemas for cv/tailored/requests"
```

---

### Task 3: Mongo job fetch (`db.py`)

**Files:**
- Create: `Backend/cv_tailoring_service/app/db.py`
- Test: `Backend/cv_tailoring_service/tests/test_db.py`

**Interfaces:**
- Consumes: `app.config:get_settings`.
- Produces: `get_job(job_id: str) -> dict | None` (returns the job document or `None` for a bad/absent id); `job_to_text(job: dict) -> str` (concatenates title+description+skills+companyName for keyword extraction).

- [ ] **Step 1: Write the failing test**

`tests/test_db.py`:
```python
from app import db

def test_job_to_text_concatenates():
    job = {"title": "Backend Engineer", "description": "Build APIs", "skills": ["Python", "FastAPI"], "companyName": "ACME"}
    text = db.job_to_text(job)
    assert "Backend Engineer" in text
    assert "Build APIs" in text
    assert "Python" in text and "FastAPI" in text

def test_get_job_bad_id_returns_none(monkeypatch):
    # Invalid ObjectId must not raise — returns None.
    assert db.get_job("not-a-valid-objectid") is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_db.py -v`
Expected: FAIL — `ModuleNotFoundError: app.db`.

- [ ] **Step 3: Create `app/db.py`**

```python
from functools import lru_cache
from bson import ObjectId
from bson.errors import InvalidId
from pymongo import MongoClient
from app.config import get_settings


@lru_cache
def _client() -> MongoClient:
    return MongoClient(get_settings().mongo_uri)


def _jobs():
    return _client()[get_settings().mongo_db]["jobs"]


def get_job(job_id: str):
    try:
        oid = ObjectId(job_id)
    except (InvalidId, TypeError):
        return None
    return _jobs().find_one({"_id": oid})


def job_to_text(job: dict) -> str:
    parts = [
        job.get("title", ""),
        job.get("description", ""),
        job.get("companyName", ""),
        " ".join(job.get("skills", []) or []),
        " ".join(job.get("languages", []) or []),
    ]
    return "\n".join(p for p in parts if p)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_db.py -v`
Expected: PASS (`get_job` returns `None` for the invalid id without touching Mongo).

- [ ] **Step 5: Commit**

```bash
git add Backend/cv_tailoring_service/app/db.py Backend/cv_tailoring_service/tests/test_db.py
git commit -m "feat(cv-tailoring): add mongo job fetch and job_to_text"
```

---

### Task 4: JD keyword extraction (`keywords.py`)

**Files:**
- Create: `Backend/cv_tailoring_service/app/keywords.py`
- Test: `Backend/cv_tailoring_service/tests/test_keywords.py`

**Interfaces:**
- Produces: `extract_keywords(job: dict, top_k: int = 20) -> list[str]` — union of the job's explicit `skills` (verbatim, first) and top TF-IDF terms from the JD text, deduped, lowercased-compared but original-cased in output.

- [ ] **Step 1: Write the failing test**

`tests/test_keywords.py`:
```python
from app.keywords import extract_keywords

def test_includes_explicit_skills_first():
    job = {"title": "Data Engineer", "description": "airflow spark kafka pipelines", "skills": ["Airflow", "Spark"]}
    kws = extract_keywords(job, top_k=10)
    assert "Airflow" in kws and "Spark" in kws
    # explicit skills come before tfidf-only terms
    assert kws.index("Airflow") < len(job["skills"]) + 0.5 * len(kws)

def test_extracts_terms_from_description_when_no_skills():
    job = {"title": "", "description": "kubernetes kubernetes docker terraform", "skills": []}
    kws = [k.lower() for k in extract_keywords(job, top_k=5)]
    assert "kubernetes" in kws

def test_no_crash_on_empty_job():
    assert extract_keywords({}, top_k=5) == []
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_keywords.py -v`
Expected: FAIL — `ModuleNotFoundError: app.keywords`.

- [ ] **Step 3: Create `app/keywords.py`**

```python
from sklearn.feature_extraction.text import TfidfVectorizer
from app.db import job_to_text


def _dedupe_preserve(seq):
    seen, out = set(), []
    for s in seq:
        key = s.strip().lower()
        if key and key not in seen:
            seen.add(key)
            out.append(s.strip())
    return out


def extract_keywords(job: dict, top_k: int = 20) -> list[str]:
    explicit = list(job.get("skills", []) or [])
    text = job_to_text(job)
    tfidf_terms = []
    if text.strip():
        try:
            vec = TfidfVectorizer(stop_words="english", ngram_range=(1, 2), max_features=200)
            matrix = vec.fit_transform([text])
            scores = matrix.toarray()[0]
            names = vec.get_feature_names_out()
            ranked = sorted(zip(names, scores), key=lambda x: x[1], reverse=True)
            tfidf_terms = [name for name, score in ranked if score > 0]
        except ValueError:
            tfidf_terms = []
    return _dedupe_preserve(explicit + tfidf_terms)[:top_k]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_keywords.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add Backend/cv_tailoring_service/app/keywords.py Backend/cv_tailoring_service/tests/test_keywords.py
git commit -m "feat(cv-tailoring): add TF-IDF JD keyword extraction"
```

---

### Task 5: Groq reformulation (`llm.py`)

**Files:**
- Create: `Backend/cv_tailoring_service/app/llm.py`
- Test: `Backend/cv_tailoring_service/tests/test_llm.py`

**Interfaces:**
- Consumes: `app.config:get_settings`, `app.schema:TailoredCv`.
- Produces: `SYSTEM_PROMPT: str`; `TAILORED_JSON_SCHEMA: dict`; `tailor_cv(cv_json: dict, keywords: list[str], extra_instruction: str = "") -> TailoredCv`. Uses `httpx.post` to `{groq_base_url}/chat/completions` with `response_format` json-schema strict; validates the returned content with `TailoredCv`.

- [ ] **Step 1: Write the failing test**

`tests/test_llm.py`:
```python
import json
import httpx
from app import llm

FAKE = {"summary": "Reformulated", "experiences": [{"title": "Dev", "company": "ACME", "duration": "2020", "description": "did x"}],
        "skills": ["Python"], "education": ["BSc"], "changes_applied": ["reordered skills"]}

def test_tailor_cv_parses_response(monkeypatch):
    captured = {}
    def fake_post(url, **kwargs):
        captured["url"] = url
        captured["json"] = kwargs.get("json")
        captured["headers"] = kwargs.get("headers")
        content = json.dumps(FAKE)
        return httpx.Response(200, json={"choices": [{"message": {"content": content}}]})
    monkeypatch.setattr(llm.httpx, "post", fake_post)

    out = llm.tailor_cv({"name": "Ada", "profile": {"skills": ["Python"]}}, ["python", "sql"])
    assert out.summary == "Reformulated"
    assert out.changes_applied == ["reordered skills"]
    # request shape
    assert captured["url"].endswith("/chat/completions")
    assert captured["json"]["response_format"]["type"] == "json_schema"
    assert "Bearer" in captured["headers"]["Authorization"]
    # keywords are passed into the user message
    user_msg = captured["json"]["messages"][-1]["content"]
    assert "python" in user_msg.lower()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_llm.py -v`
Expected: FAIL — `ModuleNotFoundError: app.llm`.

- [ ] **Step 3: Create `app/llm.py`**

```python
import json
import httpx
from app.config import get_settings
from app.schema import TailoredCv

SYSTEM_PROMPT = (
    "Tu es un assistant de reformulation de CV. On te donne un CV au format JSON et la liste "
    "des exigences cles d'une offre d'emploi. Ta tache : reformuler le CV pour mieux correspondre "
    "a l'offre.\n\n"
    "REGLES STRICTES :\n"
    "1. N'ajoute AUCUNE competence, experience, diplome ou certification absente du CV original.\n"
    "2. Garde INTACTS : noms d'entreprises, dates, intitules de diplomes, chiffres et resultats.\n"
    "3. Tu peux : reformuler les descriptions, reordonner competences/experiences par pertinence, "
    "adapter le vocabulaire a celui de l'offre, mettre en avant ce qui correspond.\n"
    "4. Redige dans la meme langue que le CV original.\n"
    "5. Reponds UNIQUEMENT en JSON conforme au schema fourni, sans texte autour."
)

TAILORED_JSON_SCHEMA = {
    "type": "object",
    "properties": {
        "summary": {"type": "string"},
        "experiences": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "title": {"type": "string"},
                    "company": {"type": "string"},
                    "duration": {"type": "string"},
                    "description": {"type": "string"},
                },
                "required": ["title", "company", "duration", "description"],
                "additionalProperties": False,
            },
        },
        "skills": {"type": "array", "items": {"type": "string"}},
        "education": {"type": "array", "items": {"type": "string"}},
        "changes_applied": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["summary", "experiences", "skills", "education", "changes_applied"],
    "additionalProperties": False,
}


class LlmError(RuntimeError):
    pass


def _user_message(cv_json: dict, keywords: list[str], extra_instruction: str) -> str:
    return (
        "EXIGENCES CLES DE L'OFFRE (mots-cles):\n" + ", ".join(keywords) + "\n\n"
        "CV ORIGINAL (JSON):\n" + json.dumps(cv_json, ensure_ascii=False)
        + (("\n\nCONTRAINTE SUPPLEMENTAIRE:\n" + extra_instruction) if extra_instruction else "")
    )


def tailor_cv(cv_json: dict, keywords: list[str], extra_instruction: str = "") -> TailoredCv:
    s = get_settings()
    payload = {
        "model": s.groq_model,
        "temperature": 0.4,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": _user_message(cv_json, keywords, extra_instruction)},
        ],
        "response_format": {
            "type": "json_schema",
            "json_schema": {"name": "tailored_cv", "strict": True, "schema": TAILORED_JSON_SCHEMA},
        },
    }
    try:
        resp = httpx.post(
            f"{s.groq_base_url}/chat/completions",
            json=payload,
            headers={"Authorization": f"Bearer {s.groq_api_key}", "Content-Type": "application/json"},
            timeout=90,
        )
        resp.raise_for_status()
        content = resp.json()["choices"][0]["message"]["content"]
    except (httpx.HTTPError, KeyError, IndexError) as e:
        raise LlmError(f"Groq request failed: {e}") from e
    try:
        return TailoredCv.model_validate_json(content)
    except ValueError as e:
        raise LlmError(f"Groq returned invalid tailored JSON: {e}") from e
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_llm.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add Backend/cv_tailoring_service/app/llm.py Backend/cv_tailoring_service/tests/test_llm.py
git commit -m "feat(cv-tailoring): add Groq schema-strict CV reformulation"
```

---

### Task 6: Anti-hallucination (`anti_hallucination.py`)

**Files:**
- Create: `Backend/cv_tailoring_service/app/anti_hallucination.py`
- Test: `Backend/cv_tailoring_service/tests/test_anti_hallucination.py`

**Interfaces:**
- Consumes: `app.schema:CvJson`, `app.schema:TailoredCv`, `app.schema:Verification`.
- Produces: `factual_entities(text: str) -> set[str]` (spaCy ORG/DATE/CARDINAL/PERCENT + regex for years, numbers, degree tokens); `original_entities(cv: dict) -> set[str]`; `tailored_entities(tailored: dict) -> set[str]`; `verify(cv: dict, tailored: dict, retried: bool = False) -> Verification` (invented = tailored factual entities absent from original; `passed = not invented`).

- [ ] **Step 1: Write the failing test**

`tests/test_anti_hallucination.py`:
```python
from app.anti_hallucination import verify, factual_entities

ORIGINAL = {
    "name": "Ada", "profile": {"experience": [{"company": "ACME", "duration": "2020-2022", "description": "Built 3 services"}], "skills": ["Python"]},
    "education": ["BSc Computer Science 2019"],
}

def test_clean_reformulation_passes():
    tailored = {"summary": "s", "experiences": [{"title": "Dev", "company": "ACME", "duration": "2020-2022", "description": "Engineered 3 services"}], "skills": ["Python"], "education": ["BSc Computer Science 2019"], "changes_applied": []}
    v = verify(ORIGINAL, tailored)
    assert v.passed is True
    assert v.invented_entities == []

def test_invented_company_is_flagged():
    tailored = {"summary": "s", "experiences": [{"title": "Dev", "company": "Google", "duration": "2020-2022", "description": "x"}], "skills": ["Python"], "education": ["BSc Computer Science 2019"], "changes_applied": []}
    v = verify(ORIGINAL, tailored)
    assert v.passed is False
    assert any("google" in e.lower() for e in v.invented_entities)

def test_invented_year_is_flagged():
    tailored = {"summary": "s", "experiences": [{"title": "Dev", "company": "ACME", "duration": "2025-2030", "description": "x"}], "skills": ["Python"], "education": ["BSc Computer Science 2019"], "changes_applied": []}
    v = verify(ORIGINAL, tailored)
    assert v.passed is False
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_anti_hallucination.py -v`
Expected: FAIL — `ModuleNotFoundError: app.anti_hallucination`.

- [ ] **Step 3: Create `app/anti_hallucination.py`**

```python
import re
import spacy
from app.schema import Verification

_nlp = spacy.load("en_core_web_sm", disable=["lemmatizer"])

_YEAR_RE = re.compile(r"\b(19|20)\d{2}\b")
_NUM_RE = re.compile(r"\b\d+(?:[.,]\d+)?%?\b")
_DEGREE_RE = re.compile(
    r"\b(bsc|msc|ph\.?d|b\.?a|m\.?a|bac|licence|master|ingenieur|engineer|doctorat|mba|dut|bts)\b",
    re.IGNORECASE,
)
_STOP_ENT = {"", "cv", "resume"}


def _norm(tok: str) -> str:
    return re.sub(r"[^\w%]+", " ", tok, flags=re.UNICODE).strip().lower()


def factual_entities(text: str) -> set[str]:
    if not text:
        return set()
    ents: set[str] = set()
    doc = _nlp(text)
    for ent in doc.ents:
        if ent.label_ in {"ORG", "DATE", "CARDINAL", "PERCENT", "GPE", "MONEY", "QUANTITY"}:
            n = _norm(ent.text)
            if n and n not in _STOP_ENT:
                ents.add(n)
    for m in _YEAR_RE.finditer(text):
        ents.add(m.group(0))
    for m in _NUM_RE.finditer(text):
        ents.add(_norm(m.group(0)))
    for m in _DEGREE_RE.finditer(text):
        ents.add(_norm(m.group(0)))
    return {e for e in ents if e and e not in _STOP_ENT}


def _cv_text(cv: dict) -> str:
    profile = cv.get("profile", {}) or {}
    parts = [cv.get("name", ""), cv.get("domain", ""), profile.get("resume", ""), profile.get("shortDescription", "")]
    parts += list(profile.get("skills", []) or [])
    parts += list(cv.get("education", []) or [])
    for exp in profile.get("experience", []) or []:
        parts += [exp.get("title", ""), exp.get("company", ""), exp.get("duration", ""), exp.get("description", "")]
    return "\n".join(str(p) for p in parts if p)


def _tailored_text(tailored: dict) -> str:
    parts = [tailored.get("summary", "")]
    parts += list(tailored.get("skills", []) or [])
    parts += list(tailored.get("education", []) or [])
    for exp in tailored.get("experiences", []) or []:
        parts += [exp.get("title", ""), exp.get("company", ""), exp.get("duration", ""), exp.get("description", "")]
    return "\n".join(str(p) for p in parts if p)


def _structured_orgs(experiences) -> set[str]:
    # Company names live in structured `company` fields and must stay intact.
    # Compare them directly — spaCy's en_core_web_sm does NOT reliably tag an
    # ORG in bare newline-joined field fragments (no sentence context).
    orgs = set()
    for exp in experiences or []:
        n = _norm((exp or {}).get("company", ""))
        if n and n not in _STOP_ENT:
            orgs.add(n)
    return orgs


def original_entities(cv: dict) -> set[str]:
    profile = cv.get("profile", {}) or {}
    return factual_entities(_cv_text(cv)) | _structured_orgs(profile.get("experience", []))


def tailored_entities(tailored: dict) -> set[str]:
    return factual_entities(_tailored_text(tailored)) | _structured_orgs(tailored.get("experiences", []))


def verify(cv: dict, tailored: dict, retried: bool = False) -> Verification:
    original = original_entities(cv)
    invented = sorted(tailored_entities(tailored) - original)
    return Verification(passed=len(invented) == 0, invented_entities=invented, retried=retried)
```

Note: remove the dead `for m in _YEAR_RE.findall(text): pass` loop when implementing — it is illustrative only; keep the `finditer` loop.

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_anti_hallucination.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add Backend/cv_tailoring_service/app/anti_hallucination.py Backend/cv_tailoring_service/tests/test_anti_hallucination.py
git commit -m "feat(cv-tailoring): add spaCy anti-hallucination entity check"
```

---

### Task 7: Orchestration (`service.py`)

**Files:**
- Create: `Backend/cv_tailoring_service/app/service.py`
- Test: `Backend/cv_tailoring_service/tests/test_service.py`

**Interfaces:**
- Consumes: `db.get_job`, `keywords.extract_keywords`, `llm.tailor_cv`, `anti_hallucination.verify`, schemas.
- Produces: `class TailorRejected(Exception)` (has `.verification: Verification`); `class JobNotFound(Exception)`; `run_tailor(candidate_id, job_id, cv_json_dict) -> TailorResponse`. Retries the LLM once with an `extra_instruction` naming invented entities; raises `TailorRejected` if the second pass still fails.

- [ ] **Step 1: Write the failing test**

`tests/test_service.py`:
```python
import pytest
from app import service
from app.schema import TailoredCv, Verification

CV = {"name": "Ada", "profile": {"skills": ["Python"], "experience": []}, "education": []}

def _tailored(summary="s"):
    return TailoredCv(summary=summary, experiences=[], skills=["Python"], education=[], changes_applied=["x"])

def test_run_tailor_happy(monkeypatch):
    monkeypatch.setattr(service, "get_job", lambda jid: {"title": "Dev", "skills": ["Python"]})
    monkeypatch.setattr(service, "extract_keywords", lambda job, top_k=20: ["python"])
    monkeypatch.setattr(service, "tailor_cv", lambda cv, kw, extra_instruction="": _tailored())
    monkeypatch.setattr(service, "verify", lambda cv, t, retried=False: Verification(passed=True, retried=retried))
    resp = service.run_tailor("c1", "j1", CV)
    assert resp.verification.passed is True
    assert resp.changes_applied == ["x"]

def test_run_tailor_retries_then_passes(monkeypatch):
    calls = {"n": 0}
    monkeypatch.setattr(service, "get_job", lambda jid: {"title": "Dev"})
    monkeypatch.setattr(service, "extract_keywords", lambda job, top_k=20: ["python"])
    monkeypatch.setattr(service, "tailor_cv", lambda cv, kw, extra_instruction="": _tailored())
    def fake_verify(cv, t, retried=False):
        calls["n"] += 1
        return Verification(passed=calls["n"] > 1, invented_entities=[] if calls["n"] > 1 else ["google"], retried=retried)
    monkeypatch.setattr(service, "verify", fake_verify)
    resp = service.run_tailor("c1", "j1", CV)
    assert resp.verification.passed is True
    assert resp.verification.retried is True

def test_run_tailor_rejects_after_retry(monkeypatch):
    monkeypatch.setattr(service, "get_job", lambda jid: {"title": "Dev"})
    monkeypatch.setattr(service, "extract_keywords", lambda job, top_k=20: ["python"])
    monkeypatch.setattr(service, "tailor_cv", lambda cv, kw, extra_instruction="": _tailored())
    monkeypatch.setattr(service, "verify", lambda cv, t, retried=False: Verification(passed=False, invented_entities=["google"], retried=retried))
    with pytest.raises(service.TailorRejected):
        service.run_tailor("c1", "j1", CV)

def test_run_tailor_job_not_found(monkeypatch):
    monkeypatch.setattr(service, "get_job", lambda jid: None)
    with pytest.raises(service.JobNotFound):
        service.run_tailor("c1", "bad", CV)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_service.py -v`
Expected: FAIL — `ModuleNotFoundError: app.service`.

- [ ] **Step 3: Create `app/service.py`**

```python
from app.db import get_job
from app.keywords import extract_keywords
from app.llm import tailor_cv
from app.anti_hallucination import verify
from app.schema import Verification, TailoredCv, TailorResponse


class JobNotFound(Exception):
    pass


class TailorRejected(Exception):
    def __init__(self, verification: Verification):
        super().__init__("Tailored CV failed anti-hallucination after retry")
        self.verification = verification


def run_tailor(candidate_id: str, job_id: str, cv_json_dict: dict) -> TailorResponse:
    job = get_job(job_id)
    if job is None:
        raise JobNotFound(job_id)
    keywords = extract_keywords(job, top_k=20)

    tailored: TailoredCv = tailor_cv(cv_json_dict, keywords)
    v = verify(cv_json_dict, tailored.model_dump())

    if not v.passed:
        extra = (
            "Le CV precedent a introduit des elements factuels ABSENTS de l'original: "
            + ", ".join(v.invented_entities)
            + ". Ne les inclus pas. N'ajoute aucune entreprise, date, diplome ou chiffre absent de l'original."
        )
        tailored = tailor_cv(cv_json_dict, keywords, extra_instruction=extra)
        v = verify(cv_json_dict, tailored.model_dump(), retried=True)
        if not v.passed:
            raise TailorRejected(v)

    return TailorResponse(tailored_cv_json=tailored, changes_applied=tailored.changes_applied, verification=v)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_service.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add Backend/cv_tailoring_service/app/service.py Backend/cv_tailoring_service/tests/test_service.py
git commit -m "feat(cv-tailoring): orchestrate tailor flow with one anti-hallucination retry"
```

---

### Task 8: `/tailor` endpoint

**Files:**
- Modify: `Backend/cv_tailoring_service/app/main.py`
- Test: `Backend/cv_tailoring_service/tests/test_tailor_endpoint.py`

**Interfaces:**
- Consumes: `service.run_tailor`, `service.JobNotFound`, `service.TailorRejected`, `schema.TailorRequest`, `schema.TailorResponse`.
- Produces: `POST /tailor` → 200 `TailorResponse`; 404 if job missing; 422 with `{detail, invented_entities}` if rejected.

- [ ] **Step 1: Write the failing test**

`tests/test_tailor_endpoint.py`:
```python
from fastapi.testclient import TestClient
from app import main
from app.schema import TailorResponse, TailoredCv, Verification
from app import service

client = TestClient(main.app)

CV = {"name": "Ada", "profile": {"skills": ["Python"], "experience": []}, "education": []}

def test_tailor_ok(monkeypatch):
    resp = TailorResponse(tailored_cv_json=TailoredCv(summary="s", changes_applied=["c"]), changes_applied=["c"], verification=Verification(passed=True))
    monkeypatch.setattr(main, "run_tailor", lambda *a, **k: resp)
    r = client.post("/tailor", json={"candidate_id": "c1", "job_id": "j1", "cv_json": CV})
    assert r.status_code == 200
    assert r.json()["verification"]["passed"] is True

def test_tailor_rejected_422(monkeypatch):
    def boom(*a, **k):
        raise service.TailorRejected(Verification(passed=False, invented_entities=["google"]))
    monkeypatch.setattr(main, "run_tailor", boom)
    r = client.post("/tailor", json={"candidate_id": "c1", "job_id": "j1", "cv_json": CV})
    assert r.status_code == 422
    assert r.json()["detail"]["invented_entities"] == ["google"]

def test_tailor_job_not_found_404(monkeypatch):
    def boom(*a, **k):
        raise service.JobNotFound("j1")
    monkeypatch.setattr(main, "run_tailor", boom)
    r = client.post("/tailor", json={"candidate_id": "c1", "job_id": "j1", "cv_json": CV})
    assert r.status_code == 404
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_tailor_endpoint.py -v`
Expected: FAIL — `/tailor` returns 404 (route not defined) or `run_tailor` attribute missing.

- [ ] **Step 3: Modify `app/main.py`**

Replace the file with:
```python
from fastapi import FastAPI, HTTPException
from app.schema import TailorRequest, TailorResponse
from app.service import run_tailor, JobNotFound, TailorRejected
from app.llm import LlmError

app = FastAPI(title="cv-tailoring-service")


@app.get("/health")
def health():
    return {"status": "ok", "service": "cv-tailoring-service"}


@app.post("/tailor", response_model=TailorResponse)
def tailor(req: TailorRequest):
    try:
        return run_tailor(req.candidate_id, req.job_id, req.cv_json.model_dump())
    except JobNotFound:
        raise HTTPException(status_code=404, detail="Job not found")
    except TailorRejected as e:
        raise HTTPException(status_code=422, detail={
            "message": "Tailored CV introduced facts absent from the original.",
            "invented_entities": e.verification.invented_entities,
        })
    except LlmError as e:
        raise HTTPException(status_code=502, detail=f"LLM reformulation failed: {e}")
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_tailor_endpoint.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add Backend/cv_tailoring_service/app/main.py Backend/cv_tailoring_service/tests/test_tailor_endpoint.py
git commit -m "feat(cv-tailoring): add POST /tailor endpoint"
```

---

### Task 9: Internal → Reactive Resume mapping (`mapping.py`)

**Files:**
- Create: `Backend/cv_tailoring_service/app/mapping.py`
- Create: `Backend/cv_tailoring_service/tests/fixtures/rxresume_base.json` (the empty-resume `data` object captured from the instance)
- Test: `Backend/cv_tailoring_service/tests/test_mapping.py`

**Interfaces:**
- Produces: `to_rxresume_data(cv_json: dict, tailored: dict, base_data: dict) -> dict`. Populates a deep copy of `base_data`. **Item builders are the PROVISIONAL zone** — `_experience_item`, `_education_item`, `_skill_item`, `_language_item` are the only place to adjust field names after confirming against a populated local export.

- [ ] **Step 1: Create the fixture** `tests/fixtures/rxresume_base.json`

Paste the `data` object of an empty resume from the local instance. Until the local instance is available, use this captured empty-resume `data` (container confirmed from a live GET):
```json
{
  "picture": {"hidden": false, "url": "", "size": 80, "borderRadius": 0},
  "basics": {"name": "", "headline": "", "email": "", "phone": "", "location": "", "website": {"url": "", "label": ""}, "customFields": []},
  "summary": {"title": "", "icon": "article", "columns": 1, "hidden": false, "content": ""},
  "sections": {
    "profiles": {"title": "", "icon": "messenger-logo", "columns": 1, "hidden": false, "items": []},
    "experience": {"title": "", "icon": "briefcase", "columns": 1, "hidden": false, "items": []},
    "education": {"title": "", "icon": "graduation-cap", "columns": 1, "hidden": false, "items": []},
    "skills": {"title": "", "icon": "compass-tool", "columns": 1, "hidden": false, "items": []},
    "languages": {"title": "", "icon": "translate", "columns": 1, "hidden": false, "items": []}
  },
  "customSections": [],
  "metadata": {"template": "azurill", "layout": {"sidebarWidth": 35, "pages": [{"fullWidth": false, "main": ["summary", "education", "experience"], "sidebar": ["skills", "languages"]}]}}
}
```

- [ ] **Step 2: Write the failing test**

`tests/test_mapping.py`:
```python
import json, os
from app.mapping import to_rxresume_data

BASE = json.load(open(os.path.join(os.path.dirname(__file__), "fixtures", "rxresume_base.json"), encoding="utf-8"))

CV = {"name": "Ada Lovelace", "email": "ada@x.io", "phone": "+216 20", "domain": "Software",
      "profile": {"languages": ["English", "French"], "skills": ["Python"]}}
TAILORED = {"summary": "Great engineer", "skills": ["Python", "SQL"],
            "experiences": [{"title": "Dev", "company": "ACME", "duration": "2020-2022", "description": "Built APIs"}],
            "education": ["BSc CS, Univ Tunis, 2019"], "changes_applied": []}

def test_basics_populated():
    data = to_rxresume_data(CV, TAILORED, BASE)
    assert data["basics"]["name"] == "Ada Lovelace"
    assert data["basics"]["email"] == "ada@x.io"
    assert data["summary"]["content"]  # non-empty
    assert "Great engineer" in data["summary"]["content"]

def test_sections_items_counts():
    data = to_rxresume_data(CV, TAILORED, BASE)
    assert len(data["sections"]["experience"]["items"]) == 1
    assert len(data["sections"]["education"]["items"]) == 1
    assert len(data["sections"]["skills"]["items"]) == 2
    assert len(data["sections"]["languages"]["items"]) == 2

def test_does_not_mutate_base():
    to_rxresume_data(CV, TAILORED, BASE)
    assert BASE["sections"]["experience"]["items"] == []

def test_experience_item_has_company_and_date():
    data = to_rxresume_data(CV, TAILORED, BASE)
    item = data["sections"]["experience"]["items"][0]
    assert item["company"] == "ACME"
    assert item["date"] == "2020-2022"
```

- [ ] **Step 3: Run test to verify it fails**

Run: `python -m pytest tests/test_mapping.py -v`
Expected: FAIL — `ModuleNotFoundError: app.mapping`.

- [ ] **Step 4: Create `app/mapping.py`**

```python
import copy
import uuid


def _id() -> str:
    return uuid.uuid4().hex


def _html(text: str) -> str:
    text = (text or "").strip()
    return f"<p>{text}</p>" if text else ""


# --- PROVISIONAL item builders: adjust field names here once a populated -----
# --- local resume export confirms the exact item schema. --------------------

def _experience_item(exp: dict) -> dict:
    return {
        "id": _id(),
        "visible": True,
        "company": exp.get("company", ""),
        "position": exp.get("title", ""),
        "location": "",
        "date": exp.get("duration", ""),
        "summary": _html(exp.get("description", "")),
        "url": {"label": "", "href": ""},
    }


def _education_item(line: str) -> dict:
    return {
        "id": _id(),
        "visible": True,
        "institution": "",
        "studyType": "",
        "area": "",
        "score": "",
        "date": "",
        "summary": _html(line),
        "url": {"label": "", "href": ""},
    }


def _skill_item(name: str) -> dict:
    return {"id": _id(), "visible": True, "name": name, "description": "", "level": 0, "keywords": []}


def _language_item(name: str) -> dict:
    return {"id": _id(), "visible": True, "name": name, "description": "", "level": 0}
# ----------------------------------------------------------------------------


def to_rxresume_data(cv_json: dict, tailored: dict, base_data: dict) -> dict:
    data = copy.deepcopy(base_data)
    profile = cv_json.get("profile", {}) or {}

    data["basics"]["name"] = cv_json.get("name", "")
    data["basics"]["email"] = cv_json.get("email", "")
    data["basics"]["phone"] = cv_json.get("phone", "")
    headline = cv_json.get("domain", "")
    if not headline and tailored.get("experiences"):
        headline = tailored["experiences"][0].get("title", "")
    data["basics"]["headline"] = headline

    data["summary"]["content"] = _html(tailored.get("summary", ""))

    data["sections"]["experience"]["items"] = [_experience_item(e) for e in tailored.get("experiences", [])]
    data["sections"]["education"]["items"] = [_education_item(x) for x in tailored.get("education", [])]
    data["sections"]["skills"]["items"] = [_skill_item(s) for s in tailored.get("skills", [])]
    data["sections"]["languages"]["items"] = [_language_item(l) for l in profile.get("languages", [])]

    return data
```

- [ ] **Step 5: Run test to verify it passes**

Run: `python -m pytest tests/test_mapping.py -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add Backend/cv_tailoring_service/app/mapping.py Backend/cv_tailoring_service/tests/test_mapping.py Backend/cv_tailoring_service/tests/fixtures/rxresume_base.json
git commit -m "feat(cv-tailoring): map internal tailored CV to Reactive Resume data"
```

---

### Task 10: Reactive Resume client (`rxresume_client.py`)

**Files:**
- Create: `Backend/cv_tailoring_service/app/rxresume_client.py`
- Test: `Backend/cv_tailoring_service/tests/test_rxresume_client.py`

**Interfaces:**
- Consumes: `app.config:get_settings`, `app.mapping:to_rxresume_data`.
- Produces: `class RxResumeError(RuntimeError)`; `class RxResumeClient` with `__init__(self, http=httpx)`, methods `fetch_base_data() -> dict`, `assert_schema(data: dict)`, `create_resume(data: dict, name: str) -> str` (returns resume id), `export_pdf(resume_id: str) -> str` (returns PDF url), `download(url: str) -> bytes`, `save_pdf(content: bytes, candidate_id: str) -> str` (returns `/uploads/tailored-cvs/<file>.pdf`), and `generate(cv_json: dict, tailored: dict, candidate_id: str) -> tuple[str, str]` (returns `(pdf_path, resume_id)`). All requests send header `x-api-key`.

> **PROVISIONAL endpoints (spec §14):** `fetch_base_data` and `export_pdf` use the v4 openapi routes below; confirm exact paths against the pinned instance. `create_resume` = `POST /api/openapi/resumes`; `fetch_base_data` creates then reads a throwaway resume to obtain a fresh `data` skeleton; `export_pdf` = `POST /api/openapi/resumes/{id}/export/pdf` returning `{url}`. Keep all route strings in this module.

- [ ] **Step 1: Write the failing test**

`tests/test_rxresume_client.py`:
```python
import json, os
import httpx
import pytest
from app import rxresume_client
from app.rxresume_client import RxResumeClient, RxResumeError

BASE = json.load(open(os.path.join(os.path.dirname(__file__), "fixtures", "rxresume_base.json"), encoding="utf-8"))


class FakeHttp:
    def __init__(self, responses):
        self.responses = responses
        self.calls = []

    def request(self, method, url, **kwargs):
        self.calls.append((method, url, kwargs))
        status, payload, content = self.responses.pop(0)
        if content is not None:
            return httpx.Response(status, content=content, request=httpx.Request(method, url))
        return httpx.Response(status, json=payload, request=httpx.Request(method, url))


def test_assert_schema_raises_on_missing_keys():
    c = RxResumeClient(http=FakeHttp([]))
    with pytest.raises(RxResumeError):
        c.assert_schema({"basics": {}})  # no 'sections'

def test_create_resume_sends_api_key(monkeypatch):
    fake = FakeHttp([(201, {"id": "res-1"}, None)])
    monkeypatch.setattr(rxresume_client, "get_settings", lambda: _settings())
    c = RxResumeClient(http=fake)
    rid = c.create_resume(BASE, "tailored")
    assert rid == "res-1"
    method, url, kwargs = fake.calls[0]
    assert kwargs["headers"]["x-api-key"] == "KEY"

def test_save_pdf_writes_file(tmp_path, monkeypatch):
    monkeypatch.setattr(rxresume_client, "get_settings", lambda: _settings(str(tmp_path)))
    c = RxResumeClient(http=FakeHttp([]))
    path = c.save_pdf(b"%PDF-1.4 test", "cand-9")
    assert path.startswith("/uploads/tailored-cvs/")
    saved = os.path.join(str(tmp_path), os.path.basename(path))
    assert os.path.exists(saved)


def _settings(upload_dir="/tmp/tailored"):
    class S:
        rxresume_url = "http://localhost:3000"
        rxresume_api_key = "KEY"
        tailored_cv_upload_dir = upload_dir
    return S()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_rxresume_client.py -v`
Expected: FAIL — `ModuleNotFoundError: app.rxresume_client`.

- [ ] **Step 3: Create `app/rxresume_client.py`**

```python
import os
import uuid
import httpx
from app.config import get_settings
from app.mapping import to_rxresume_data

_REQUIRED_KEYS = ("basics", "summary", "sections", "metadata")


class RxResumeError(RuntimeError):
    pass


class RxResumeClient:
    def __init__(self, http=httpx):
        self._http = http

    # ---- low-level ---------------------------------------------------------
    def _headers(self):
        return {"x-api-key": get_settings().rxresume_api_key, "Content-Type": "application/json"}

    def _url(self, path: str) -> str:
        return f"{get_settings().rxresume_url}{path}"

    def _json_request(self, method, path, **kwargs):
        try:
            resp = self._http.request(method, self._url(path), headers=self._headers(), timeout=60, **kwargs)
            resp.raise_for_status()
            return resp.json()
        except (httpx.HTTPError, ValueError) as e:
            # ValueError covers json.JSONDecodeError on a 2xx with a bad/empty body.
            raise RxResumeError(f"Reactive Resume {method} {path} failed: {e}") from e

    # ---- schema-probe ------------------------------------------------------
    def assert_schema(self, data: dict):
        missing = [k for k in _REQUIRED_KEYS if k not in data]
        if missing:
            raise RxResumeError(f"Reactive Resume data schema mismatch — missing keys: {missing}")

    def fetch_base_data(self) -> dict:
        # PROVISIONAL: create a throwaway resume to obtain a fresh data skeleton.
        created = self._json_request("POST", "/api/openapi/resumes", json={"title": f"probe-{uuid.uuid4().hex[:8]}"})
        data = created.get("data") or created.get("resume", {}).get("data")
        if not data:
            raise RxResumeError("Could not obtain a base resume data skeleton from the instance")
        self.assert_schema(data)
        return data

    # ---- high-level --------------------------------------------------------
    def create_resume(self, data: dict, name: str) -> str:
        created = self._json_request("POST", "/api/openapi/resumes", json={"title": name, "data": data})
        rid = created.get("id") or created.get("resume", {}).get("id")
        if not rid:
            raise RxResumeError("create_resume: response missing resume id")
        return rid

    def export_pdf(self, resume_id: str) -> str:
        # PROVISIONAL endpoint — confirm against pinned instance.
        out = self._json_request("POST", f"/api/openapi/resumes/{resume_id}/export/pdf")
        url = out.get("url") or out.get("pdf")
        if not url:
            raise RxResumeError("export_pdf: response missing pdf url")
        return url

    def download(self, url: str) -> bytes:
        try:
            resp = self._http.request("GET", url, headers=self._headers(), timeout=120)
            resp.raise_for_status()
            return resp.content
        except httpx.HTTPError as e:
            raise RxResumeError(f"Failed to download PDF: {e}") from e

    def save_pdf(self, content: bytes, candidate_id: str) -> str:
        out_dir = get_settings().tailored_cv_upload_dir
        os.makedirs(out_dir, exist_ok=True)
        filename = f"tailored-{candidate_id}-{uuid.uuid4().hex[:8]}.pdf"
        with open(os.path.join(out_dir, filename), "wb") as f:
            f.write(content)
        return f"/uploads/tailored-cvs/{filename}"

    def generate(self, cv_json: dict, tailored: dict, candidate_id: str) -> tuple[str, str]:
        base = self.fetch_base_data()
        data = to_rxresume_data(cv_json, tailored, base)
        self.assert_schema(data)
        resume_id = self.create_resume(data, name=f"{cv_json.get('name', 'candidate')} — tailored")
        pdf_url = self.export_pdf(resume_id)
        content = self.download(pdf_url)
        pdf_path = self.save_pdf(content, candidate_id)
        return pdf_path, resume_id
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_rxresume_client.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add Backend/cv_tailoring_service/app/rxresume_client.py Backend/cv_tailoring_service/tests/test_rxresume_client.py
git commit -m "feat(cv-tailoring): add Reactive Resume client (probe/create/export/save)"
```

---

### Task 11: `/export-pdf` endpoint

**Files:**
- Modify: `Backend/cv_tailoring_service/app/main.py`
- Test: `Backend/cv_tailoring_service/tests/test_export_endpoint.py`

**Interfaces:**
- Consumes: `schema.ExportRequest`, `schema.ExportResponse`, `rxresume_client.RxResumeClient`, `rxresume_client.RxResumeError`.
- Produces: `POST /export-pdf` → 200 `ExportResponse`; 502 on `RxResumeError`.

- [ ] **Step 1: Write the failing test**

`tests/test_export_endpoint.py`:
```python
from fastapi.testclient import TestClient
from app import main
from app.rxresume_client import RxResumeError

CV = {"name": "Ada", "email": "a@x.io", "phone": "1", "domain": "Soft", "profile": {"languages": ["English"], "skills": ["Python"]}}
TAILORED = {"summary": "s", "experiences": [], "skills": ["Python"], "education": [], "changes_applied": []}
BODY = {"candidate_id": "c1", "job_id": "j1", "cv_json": CV, "tailored_cv_json": TAILORED}

client = TestClient(main.app)

def test_export_ok(monkeypatch):
    class FakeClient:
        def generate(self, cv, tailored, candidate_id):
            return "/uploads/tailored-cvs/x.pdf", "res-1"
    monkeypatch.setattr(main, "RxResumeClient", lambda: FakeClient())
    r = client.post("/export-pdf", json=BODY)
    assert r.status_code == 200
    assert r.json()["pdf_path"] == "/uploads/tailored-cvs/x.pdf"
    assert r.json()["resume_id"] == "res-1"

def test_export_rxresume_down_502(monkeypatch):
    class FakeClient:
        def generate(self, *a, **k):
            raise RxResumeError("connection refused")
    monkeypatch.setattr(main, "RxResumeClient", lambda: FakeClient())
    r = client.post("/export-pdf", json=BODY)
    assert r.status_code == 502
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_export_endpoint.py -v`
Expected: FAIL — `/export-pdf` route missing.

- [ ] **Step 3: Modify `app/main.py`** — add imports and the route

Add to the imports at the top:
```python
from app.schema import ExportRequest, ExportResponse
from app.rxresume_client import RxResumeClient, RxResumeError
```

Append the route:
```python
@app.post("/export-pdf", response_model=ExportResponse)
def export_pdf(req: ExportRequest):
    try:
        pdf_path, resume_id = RxResumeClient().generate(
            req.cv_json.model_dump(), req.tailored_cv_json.model_dump(), req.candidate_id or "candidate"
        )
        return ExportResponse(pdf_path=pdf_path, resume_id=resume_id)
    except RxResumeError as e:
        raise HTTPException(status_code=502, detail=f"Reactive Resume unavailable: {e}")
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_export_endpoint.py -v`
Expected: PASS.

- [ ] **Step 5: Run the full Python suite**

Run: `cd Backend/cv_tailoring_service && python -m pytest -v`
Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add Backend/cv_tailoring_service/app/main.py Backend/cv_tailoring_service/tests/test_export_endpoint.py
git commit -m "feat(cv-tailoring): add POST /export-pdf endpoint"
```

---

## Phase 2 — Express proxy + model (Node, :3001)

Node tests are plain scripts using `assert`, run with `node <file>` (matches `Backend/server/tests/faceVerifyDecision.test.js`). Keep testable logic in pure functions.

### Task 12: Application fields + `requireCandidate` middleware

**Files:**
- Modify: `Backend/server/models/Application.js`
- Modify: `Backend/server/middleware/auth.js`
- Test: `Backend/server/tests/cvTailoring.model.test.js`

**Interfaces:**
- Produces: `Application` schema paths `tailoredCvPath`, `tailoredCvJson`, `tailoredCvChanges`, `tailoredCvGeneratedAt`; `auth.requireCandidate(req, res, next)` — 403 unless `req.user.role === 'CANDIDATE'` (DB fallback for legacy tokens, mirroring `requireEnterprise`).

- [ ] **Step 1: Write the failing test**

`Backend/server/tests/cvTailoring.model.test.js`:
```javascript
const assert = require('assert');
const Application = require('../models/Application');
const { requireCandidate } = require('../middleware/auth');

// Schema paths exist
const paths = Application.schema.paths;
assert.ok(paths['tailoredCvPath'], 'tailoredCvPath missing');
assert.ok(paths['tailoredCvChanges'], 'tailoredCvChanges missing');
assert.ok(paths['tailoredCvGeneratedAt'], 'tailoredCvGeneratedAt missing');
assert.ok(Application.schema.path('tailoredCvJson'), 'tailoredCvJson missing');

// requireCandidate allows CANDIDATE
let nextCalled = false;
requireCandidate({ user: { role: 'CANDIDATE', _id: 'x' } }, { status: () => ({ json: () => {} }) }, () => { nextCalled = true; });
assert.strictEqual(nextCalled, true, 'CANDIDATE should pass');

// requireCandidate blocks ENTERPRISE without _id fallback
let blocked = 0;
requireCandidate({ user: { role: 'ENTERPRISE' } }, { status: (c) => { blocked = c; return { json: () => {} }; } }, () => {});
assert.strictEqual(blocked, 403, 'ENTERPRISE should be blocked');

console.log('cvTailoring.model.test OK');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node Backend/server/tests/cvTailoring.model.test.js`
Expected: FAIL — assertion error (`tailoredCvPath missing`) or `requireCandidate is not a function`.

- [ ] **Step 3: Modify `Backend/server/models/Application.js`**

Insert before the closing `});` of `applicationSchema` (after the `aiCoach` field at line 77):
```javascript
  tailoredCvPath: { type: String, default: null },
  tailoredCvJson: { type: mongoose.Schema.Types.Mixed, default: null },
  tailoredCvChanges: [{ type: String }],
  tailoredCvGeneratedAt: { type: Date, default: null },
```

- [ ] **Step 4: Modify `Backend/server/middleware/auth.js`**

Add before `module.exports`:
```javascript
const requireCandidate = async (req, res, next) => {
    try {
        if (req.user?.role === 'CANDIDATE') return next();
        if (!req.user?._id) return res.status(403).json({ message: 'Candidate role required' });
        const user = await UserModel.findById(req.user._id).select('role').lean();
        if (!user || user.role !== 'CANDIDATE') {
            return res.status(403).json({ message: 'Candidate role required' });
        }
        req.user.role = user.role;
        return next();
    } catch (err) {
        console.error('requireCandidate lookup failed:', err);
        return res.status(500).json({ message: 'Server error' });
    }
};
```

Change the export line to:
```javascript
module.exports = { verifyToken, requireEnterprise, requireCandidate };
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node Backend/server/tests/cvTailoring.model.test.js`
Expected: prints `cvTailoring.model.test OK`, exit 0.

- [ ] **Step 6: Commit**

```bash
git add Backend/server/models/Application.js Backend/server/middleware/auth.js Backend/server/tests/cvTailoring.model.test.js
git commit -m "feat(cv-tailoring): add tailored CV fields on Application + requireCandidate"
```

---

### Task 13: Express service pure helpers (`cvTailoringService.js`)

**Files:**
- Create: `Backend/server/services/cvTailoringService.js`
- Test: `Backend/server/tests/cvTailoringService.test.js`

**Interfaces:**
- Consumes: env `CV_TAILORING_SERVICE_URL`, `CV_PARSER_URL` (default `http://127.0.0.1:5002`); `axios`, `form-data`, `fs`.
- Produces (pure, unit-tested): `resolveCvFilePath(user, uploadDir) -> string|null` (maps `user.profile.resume` like `/uploads/cvs/x.pdf` to an absolute disk path); `buildApplicationUpdate({ pdf_path, tailored_cv_json, changes_applied }) -> object` (the `$set` for Application). Produces (network glue): `parseCv(absPath) -> cvJson`, `callTailor({candidateId, jobId, cvJson})`, `callExport({candidateId, jobId, cvJson, tailored})`.

- [ ] **Step 1: Write the failing test**

`Backend/server/tests/cvTailoringService.test.js`:
```javascript
const assert = require('assert');
const path = require('path');
const svc = require('../services/cvTailoringService');

// resolveCvFilePath maps a stored /uploads path to disk under uploadDir
const uploadDir = path.join(__dirname, '..', 'uploads');
const abs = svc.resolveCvFilePath({ profile: { resume: '/uploads/cvs/123.pdf' } }, uploadDir);
assert.ok(abs.endsWith(path.join('uploads', 'cvs', '123.pdf')), 'should resolve under uploadDir: ' + abs);

// null when no resume
assert.strictEqual(svc.resolveCvFilePath({ profile: {} }, uploadDir), null);

// buildApplicationUpdate shapes the $set
const upd = svc.buildApplicationUpdate({
  pdf_path: '/uploads/tailored-cvs/x.pdf',
  tailored_cv_json: { summary: 's' },
  changes_applied: ['a', 'b'],
});
assert.strictEqual(upd.tailoredCvPath, '/uploads/tailored-cvs/x.pdf');
assert.deepStrictEqual(upd.tailoredCvChanges, ['a', 'b']);
assert.ok(upd.tailoredCvGeneratedAt instanceof Date);

console.log('cvTailoringService.test OK');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node Backend/server/tests/cvTailoringService.test.js`
Expected: FAIL — `Cannot find module '../services/cvTailoringService'`.

- [ ] **Step 3: Create `Backend/server/services/cvTailoringService.js`**

```javascript
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const FormData = require('form-data');

const TAILORING_URL = process.env.CV_TAILORING_SERVICE_URL || 'http://localhost:8014';
const PARSER_URL = process.env.CV_PARSER_URL || 'http://127.0.0.1:5002';

// Map a stored resume path ("/uploads/cvs/x.pdf") to an absolute disk path
// under the server's uploadDir. Returns null if no resume path is stored.
function resolveCvFilePath(user, uploadDir) {
  const stored = user?.profile?.resume;
  if (!stored || typeof stored !== 'string') return null;
  const rel = stored.replace(/^\/uploads\//, '');
  return path.join(uploadDir, rel);
}

function buildApplicationUpdate({ pdf_path, tailored_cv_json, changes_applied }) {
  return {
    tailoredCvPath: pdf_path || null,
    tailoredCvJson: tailored_cv_json || null,
    tailoredCvChanges: Array.isArray(changes_applied) ? changes_applied : [],
    tailoredCvGeneratedAt: new Date(),
  };
}

async function parseCv(absPath) {
  if (!fs.existsSync(absPath)) {
    const err = new Error('Original CV file not found on disk');
    err.statusCode = 502;
    throw err;
  }
  const form = new FormData();
  form.append('resume', fs.createReadStream(absPath));
  const { data } = await axios.post(`${PARSER_URL}/upload`, form, { headers: form.getHeaders() });
  return data;
}

async function callTailor({ candidateId, jobId, cvJson }) {
  const { data } = await axios.post(`${TAILORING_URL}/tailor`, {
    candidate_id: candidateId, job_id: jobId, cv_json: cvJson,
  });
  return data;
}

async function callExport({ candidateId, jobId, cvJson, tailored }) {
  const { data } = await axios.post(`${TAILORING_URL}/export-pdf`, {
    candidate_id: candidateId, job_id: jobId, cv_json: cvJson, tailored_cv_json: tailored,
  });
  return data;
}

module.exports = {
  resolveCvFilePath,
  buildApplicationUpdate,
  parseCv,
  callTailor,
  callExport,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node Backend/server/tests/cvTailoringService.test.js`
Expected: prints `cvTailoringService.test OK`, exit 0.

- [ ] **Step 5: Commit**

```bash
git add Backend/server/services/cvTailoringService.js Backend/server/tests/cvTailoringService.test.js
git commit -m "feat(cv-tailoring): add Express service helpers for CV tailoring"
```

---

### Task 14: Express routes + mount + uploads dir

**Files:**
- Create: `Backend/server/routes/cvTailoringRoute.js`
- Modify: `Backend/server/index.js` (mount route; ensure `uploads/tailored-cvs/` exists)
- Test: `Backend/server/tests/cvTailoringRoute.test.js`

**Interfaces:**
- Consumes: `middleware/auth` (`verifyToken`, `requireCandidate`), `services/cvTailoringService`, models `user`, `Application`.
- Produces: an Express `Router` with `POST /tailor`, `POST /tailor/export`, `GET /tailored/:applicationId`, mounted at `/api/cv`.

- [ ] **Step 1: Write the failing test**

`Backend/server/tests/cvTailoringRoute.test.js`:
```javascript
const assert = require('assert');
const router = require('../routes/cvTailoringRoute');

// It exports an Express router (a function with a .stack of layers)
assert.strictEqual(typeof router, 'function', 'router should be a function');
const routePaths = router.stack.filter(l => l.route).map(l => l.route.path);
assert.ok(routePaths.includes('/tailor'), 'POST /tailor missing');
assert.ok(routePaths.includes('/tailor/export'), 'POST /tailor/export missing');
assert.ok(routePaths.includes('/tailored/:applicationId'), 'GET /tailored/:applicationId missing');

console.log('cvTailoringRoute.test OK');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node Backend/server/tests/cvTailoringRoute.test.js`
Expected: FAIL — `Cannot find module '../routes/cvTailoringRoute'`.

- [ ] **Step 3: Create `Backend/server/routes/cvTailoringRoute.js`**

```javascript
const express = require('express');
const path = require('path');
const { verifyToken, requireCandidate } = require('../middleware/auth');
const { UserModel } = require('../models/user');
const Application = require('../models/Application');
const svc = require('../services/cvTailoringService');

const router = express.Router();
const uploadDir = path.join(__dirname, '..', 'uploads');

// POST /api/cv/tailor  → reformulate (fast, JSON + changes, no PDF)
router.post('/tailor', verifyToken, requireCandidate, async (req, res) => {
  try {
    const { jobId } = req.body;
    if (!jobId) return res.status(400).json({ message: 'jobId is required' });

    const user = await UserModel.findById(req.user._id).select('name email profile').lean();
    const absPath = svc.resolveCvFilePath(user, uploadDir);
    if (!absPath) return res.status(400).json({ message: 'No CV on file to tailor. Upload a CV first.' });

    const cvJson = await svc.parseCv(absPath);
    const result = await svc.callTailor({ candidateId: String(req.user._id), jobId, cvJson });
    // Return tailored JSON + the parsed original so the client can render both panels
    return res.json({ ...result, cv_json: cvJson });
  } catch (err) {
    return forward(err, res, 'tailor');
  }
});

// POST /api/cv/tailor/export  → generate PDF and attach to the Application
router.post('/tailor/export', verifyToken, requireCandidate, async (req, res) => {
  try {
    const { jobId, cv_json, tailored_cv_json, attach } = req.body;
    if (!jobId || !cv_json || !tailored_cv_json) {
      return res.status(400).json({ message: 'jobId, cv_json and tailored_cv_json are required' });
    }
    const candidateId = String(req.user._id);
    const exported = await svc.callExport({ candidateId, jobId, cvJson: cv_json, tailored: tailored_cv_json });

    let application = null;
    if (attach) {
      const update = svc.buildApplicationUpdate({
        pdf_path: exported.pdf_path,
        tailored_cv_json,
        changes_applied: tailored_cv_json.changes_applied || [],
      });
      application = await Application.findOneAndUpdate(
        { jobId, candidateId: req.user._id },
        { $set: update },
        { new: true }
      ).lean();
    }
    return res.json({ ...exported, attached: Boolean(application), applicationId: application?._id || null });
  } catch (err) {
    return forward(err, res, 'export');
  }
});

// GET /api/cv/tailored/:applicationId  → candidate or the job's enterprise
router.get('/tailored/:applicationId', verifyToken, async (req, res) => {
  try {
    const app = await Application.findById(req.params.applicationId)
      .select('candidateId enterpriseId tailoredCvPath tailoredCvJson tailoredCvChanges tailoredCvGeneratedAt')
      .lean();
    if (!app) return res.status(404).json({ message: 'Application not found' });
    const uid = String(req.user._id);
    if (uid !== String(app.candidateId) && uid !== String(app.enterpriseId)) {
      return res.status(403).json({ message: 'Not authorized to view this tailored CV' });
    }
    return res.json({
      tailoredCvPath: app.tailoredCvPath,
      tailoredCvJson: app.tailoredCvJson,
      tailoredCvChanges: app.tailoredCvChanges,
      tailoredCvGeneratedAt: app.tailoredCvGeneratedAt,
    });
  } catch (err) {
    return forward(err, res, 'tailored-get');
  }
});

function forward(err, res, where) {
  const status = err.response?.status || err.statusCode || 500;
  const detail = err.response?.data?.detail || err.response?.data || err.message;
  console.error(`[cvTailoring:${where}]`, status, detail);
  return res.status(status >= 400 && status < 600 ? status : 502).json({
    message: 'CV tailoring failed', detail,
  });
}

module.exports = router;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node Backend/server/tests/cvTailoringRoute.test.js`
Expected: prints `cvTailoringRoute.test OK`, exit 0.

- [ ] **Step 5: Mount the route in `Backend/server/index.js`**

Find where other routers are mounted (search for `app.use("/api/`). Add:
```javascript
app.use("/api/cv", require("./routes/cvTailoringRoute"));
```
Then, near the `uploadDir` definition (`const uploadDir = path.join(__dirname, "uploads");`, line ~3356), ensure the tailored dir exists:
```javascript
const tailoredCvDir = path.join(uploadDir, "tailored-cvs");
if (!fs.existsSync(tailoredCvDir)) fs.mkdirSync(tailoredCvDir, { recursive: true });
```

- [ ] **Step 6: Verify the server still boots (syntax/mount check)**

Run: `node -e "require('./Backend/server/routes/cvTailoringRoute'); console.log('route loads')"`
Expected: prints `route loads` (no throw).

- [ ] **Step 7: Commit**

```bash
git add Backend/server/routes/cvTailoringRoute.js Backend/server/index.js Backend/server/tests/cvTailoringRoute.test.js
git commit -m "feat(cv-tailoring): add /api/cv routes and mount + ensure uploads dir"
```

---

## Phase 3 — Frontend (React, :5173)

No frontend test runner exists in this repo (ESLint only). Verify each task with `npm run lint` (from `Frontend/`) and a manual smoke run. Do NOT add a test framework.

### Task 15: API client (`cvTailoringApi.js`)

**Files:**
- Create: `Frontend/src/pages/CvTailoring/cvTailoringApi.js`

**Interfaces:**
- Produces: `tailorCv(jobId)`, `exportTailoredPdf({ jobId, cvJson, tailored, attach })`, `getTailored(applicationId)` — all returning `response.data`, using the app's axios instance / `/api` proxy and the stored auth token.

- [ ] **Step 1: Inspect how existing pages send the auth token**

Run: `grep -rn "Authorization" Frontend/src/pages | head -5`
Expected: shows the header pattern (e.g. `Bearer ${localStorage.getItem('token')}`). Match whatever the codebase uses.

- [ ] **Step 2: Create `Frontend/src/pages/CvTailoring/cvTailoringApi.js`**

```javascript
import axios from 'axios';

const authHeaders = () => ({
  headers: { Authorization: `Bearer ${localStorage.getItem('token')}` },
});

export async function tailorCv(jobId) {
  const { data } = await axios.post('/api/cv/tailor', { jobId }, authHeaders());
  return data; // { tailored_cv_json, changes_applied, verification, cv_json }
}

export async function exportTailoredPdf({ jobId, cvJson, tailored, attach }) {
  const { data } = await axios.post(
    '/api/cv/tailor/export',
    { jobId, cv_json: cvJson, tailored_cv_json: tailored, attach: Boolean(attach) },
    authHeaders()
  );
  return data; // { pdf_path, resume_id, attached, applicationId }
}

export async function getTailored(applicationId) {
  const { data } = await axios.get(`/api/cv/tailored/${applicationId}`, authHeaders());
  return data;
}
```

> If Step 1 shows the repo uses a shared axios instance (e.g. `src/api/axios.js`) or a different token key, import and use that instead of the inline header.

- [ ] **Step 3: Lint**

Run: `cd Frontend && npm run lint`
Expected: no new errors from the added file.

- [ ] **Step 4: Commit**

```bash
git add Frontend/src/pages/CvTailoring/cvTailoringApi.js
git commit -m "feat(cv-tailoring): add frontend API client"
```

---

### Task 16: Tailoring panel + button

**Files:**
- Create: `Frontend/src/pages/CvTailoring/TailorCvPanel.jsx`
- Create: `Frontend/src/pages/CvTailoring/TailorCvButton.jsx`

**Interfaces:**
- Consumes: `cvTailoringApi` (`tailorCv`, `exportTailoredPdf`).
- Produces: `<TailorCvButton jobId={...} />` (default export) rendering the "✨ Adapter mon CV à cette offre" button + cosmetic Premium badge, opening `<TailorCvPanel jobId onClose />`.

- [ ] **Step 1: Create `Frontend/src/pages/CvTailoring/TailorCvPanel.jsx`**

```jsx
import { useState } from 'react';
import { tailorCv, exportTailoredPdf } from './cvTailoringApi';

export default function TailorCvPanel({ jobId, onClose }) {
  const [loading, setLoading] = useState(false);
  const [phase, setPhase] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState(null); // { tailored_cv_json, changes_applied, verification, cv_json }
  const [pdf, setPdf] = useState(null);

  async function runTailor() {
    setLoading(true); setError(''); setPdf(null); setPhase('Reformulation en cours…');
    try {
      setResult(await tailorCv(jobId));
    } catch (e) {
      setError(e.response?.data?.detail?.message || e.response?.data?.message || 'Échec de la reformulation');
    } finally { setLoading(false); setPhase(''); }
  }

  async function runExport(attach) {
    if (!result) return;
    setLoading(true); setError(''); setPhase('Génération du PDF…');
    try {
      const out = await exportTailoredPdf({
        jobId, cvJson: result.cv_json, tailored: result.tailored_cv_json, attach,
      });
      setPdf(out);
    } catch (e) {
      setError(e.response?.data?.detail || e.response?.data?.message || 'Échec de la génération du PDF');
    } finally { setLoading(false); setPhase(''); }
  }

  const tailored = result?.tailored_cv_json;
  const verified = result?.verification?.passed;

  return (
    <div className="tailor-panel">
      <div className="tailor-panel__header">
        <h3>Adapter mon CV à cette offre ✨</h3>
        <button onClick={onClose} aria-label="Fermer">×</button>
      </div>

      {!result && !loading && (
        <button className="tailor-panel__cta" onClick={runTailor}>Générer le CV adapté</button>
      )}
      {loading && <div className="tailor-panel__loading"><span className="spinner" /> {phase}</div>}
      {error && <div className="tailor-panel__error">{error}</div>}

      {result && (
        <div className="tailor-panel__grid">
          <section className="tailor-col">
            <h4>CV original</h4>
            <pre>{JSON.stringify(result.cv_json?.profile, null, 2)}</pre>
          </section>

          <section className="tailor-col">
            <h4>Changements appliqués</h4>
            {verified && <div className="badge-verified">✅ Aucune information inventée — vérifié</div>}
            <ul>{(result.changes_applied || []).map((c, i) => <li key={i}>{c}</li>)}</ul>
          </section>

          <section className="tailor-col">
            <h4>CV adapté</h4>
            <p>{tailored?.summary}</p>
            <ul>{(tailored?.experiences || []).map((e, i) => (
              <li key={i}><strong>{e.title}</strong> — {e.company} ({e.duration})<br />{e.description}</li>
            ))}</ul>
            <p><strong>Compétences :</strong> {(tailored?.skills || []).join(', ')}</p>
          </section>
        </div>
      )}

      {result && (
        <div className="tailor-panel__actions">
          <button onClick={runTailor} disabled={loading}>Régénérer</button>
          <button onClick={() => runExport(false)} disabled={loading}>Télécharger PDF</button>
          <button onClick={() => runExport(true)} disabled={loading}>Utiliser ce CV pour ma candidature</button>
        </div>
      )}

      {pdf?.pdf_path && (
        <div className="tailor-panel__pdf">
          <a href={pdf.pdf_path} target="_blank" rel="noreferrer">📄 Ouvrir le PDF</a>
          {pdf.attached && <span> · ✅ Rattaché à votre candidature</span>}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Create `Frontend/src/pages/CvTailoring/TailorCvButton.jsx`**

```jsx
import { useState } from 'react';
import TailorCvPanel from './TailorCvPanel';

export default function TailorCvButton({ jobId }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="tailor-cta-btn" onClick={() => setOpen(true)}>
        Adapter mon CV à cette offre ✨ <span className="premium-badge">Premium</span>
      </button>
      {open && (
        <div className="tailor-modal-overlay" onClick={(e) => e.target === e.currentTarget && setOpen(false)}>
          <div className="tailor-modal">
            <TailorCvPanel jobId={jobId} onClose={() => setOpen(false)} />
          </div>
        </div>
      )}
    </>
  );
}
```

- [ ] **Step 3: Lint**

Run: `cd Frontend && npm run lint`
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add Frontend/src/pages/CvTailoring/TailorCvPanel.jsx Frontend/src/pages/CvTailoring/TailorCvButton.jsx
git commit -m "feat(cv-tailoring): add tailoring panel and entry button"
```

---

### Task 17: Mount the button on the job-detail page

**Files:**
- Modify: `Frontend/src/pages/JobDetails/JobDetails.jsx`

**Interfaces:**
- Consumes: `TailorCvButton`; the job id already available in `JobDetails` (route `/job/:id`).

- [ ] **Step 1: Confirm the job id variable + a candidate-only render point**

Run: `grep -n "useParams\|job._id\|job.id\|role" Frontend/src/pages/JobDetails/JobDetails.jsx | head`
Expected: shows the id source (e.g. `const { id } = useParams()`) and any role/auth context to gate the button to candidates.

- [ ] **Step 2: Add the import and render the button**

Add the import near the other imports:
```jsx
import TailorCvButton from '../CvTailoring/TailorCvButton';
```
Render it near the Apply action (candidates only), using the confirmed id variable:
```jsx
{/* Premium: adapt CV to this offer (cosmetic badge; no gating this iteration) */}
<TailorCvButton jobId={id} />
```

- [ ] **Step 3: Lint**

Run: `cd Frontend && npm run lint`
Expected: no new errors.

- [ ] **Step 4: Manual smoke (requires stack running — see README)**

Start Mongo, parser (5002), `cv-tailoring-service` (8014), Node (3001), Frontend (5173). As a candidate with a CV on file, open a job, click "Adapter mon CV à cette offre ✨", confirm the preview + changes render, then "Télécharger PDF".
Expected: preview appears within seconds; PDF link opens.

- [ ] **Step 5: Commit**

```bash
git add Frontend/src/pages/JobDetails/JobDetails.jsx
git commit -m "feat(cv-tailoring): mount tailoring button on job detail page"
```

---

## Phase 4 — Infra, env, docs

### Task 18: Reactive Resume Docker compose

**Files:**
- Create: `docker-compose.rxresume.yml` (repo root)

**Interfaces:**
- Produces: services `reactive-resume` (pinned image tag/digest), `rxresume-postgres`, `rxresume-minio`/chrome as required by the pinned version, persistent volumes.

- [ ] **Step 1: Create `docker-compose.rxresume.yml`**

Base it on the official self-host compose for the **pinned** version (spec §14 open item #2 — replace `<PINNED_TAG>` with the exact tag you deploy, e.g. `v4.4.6`; do not use `latest`):
```yaml
# Self-hosted Reactive Resume for NextHire CV Tailoring (RGPD: local only).
# Generate an API key after first boot: dashboard → Settings → API Keys,
# then put it in Backend/cv_tailoring_service/.env as RXRESUME_API_KEY.
services:
  rxresume-postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: reactive_resume
    volumes:
      - rxresume_pg:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 10s
      timeout: 5s
      retries: 5

  reactive-resume:
    image: amruthpillai/reactive-resume:<PINNED_TAG>
    restart: unless-stopped
    depends_on:
      rxresume-postgres:
        condition: service_healthy
    ports:
      - "3000:3000"
    environment:
      PORT: 3000
      PUBLIC_URL: http://localhost:3000
      STORAGE_URL: http://localhost:3000/storage
      DATABASE_URL: postgresql://postgres:postgres@rxresume-postgres:5432/reactive_resume
      ACCESS_TOKEN_SECRET: change-me-access
      REFRESH_TOKEN_SECRET: change-me-refresh
      CHROME_TOKEN: change-me-chrome
      MAIL_FROM: noreply@localhost
    volumes:
      - rxresume_data:/opt/uploads

volumes:
  rxresume_pg:
  rxresume_data:
```

> The exact set of required services/env vars depends on the pinned version (some versions also need a `chrome` printer service and MinIO). Copy the official `docker-compose.yml` for `<PINNED_TAG>` from the Reactive Resume repo and keep only Postgres + app + printer; freeze the tag.

- [ ] **Step 2: Validate the compose file**

Run: `docker compose -f docker-compose.rxresume.yml config`
Expected: prints the resolved config with no errors (once `<PINNED_TAG>` is set).

- [ ] **Step 3: Commit**

```bash
git add docker-compose.rxresume.yml
git commit -m "chore(cv-tailoring): add self-hosted Reactive Resume compose (pinned)"
```

---

### Task 19: Env vars + README

**Files:**
- Modify: `Backend/server/.env` and root `.env` (add `CV_TAILORING_SERVICE_URL`) — gitignored, local only.
- Modify: `.env.example` (root)
- Create: `docs/cv-tailoring/README.md`

- [ ] **Step 1: Add the Node-side env var**

Append to `Backend/server/.env` (and root `.env`):
```
CV_TAILORING_SERVICE_URL=http://localhost:8014
```
(The `RXRESUME_*` block is already in root `.env` from setup; the Python service reads `Backend/cv_tailoring_service/.env` — copy `RXRESUME_URL`, `RXRESUME_API_KEY`, `GROQ_API_KEY`, `GROQ_MODEL`, `MONGO_URI`, `CV_PARSER_URL`, `TAILORED_CV_UPLOAD_DIR` there from its `.env.example`.)

- [ ] **Step 2: Add placeholders to `.env.example`** (committed — no secret values)

Append:
```
# --- CV Tailoring / Reactive Resume (self-hosted; RGPD: local instance ONLY) ---
CV_TAILORING_SERVICE_URL=http://localhost:8014
RXRESUME_URL=http://localhost:3000
RXRESUME_API_KEY=
TAILORED_CV_UPLOAD_DIR=Backend/server/uploads/tailored-cvs
```

- [ ] **Step 3: Create `docs/cv-tailoring/README.md`**

````markdown
# CV Tailoring Premium

Reformulates a candidate's parsed CV for a specific job (Groq), verifies no facts were
invented (spaCy), renders a PDF via a **self-hosted** Reactive Resume, and attaches the
tailored CV to the Application.

## Services & ports
- `cv-tailoring-service` (FastAPI) — 8014
- CV parser (existing) — 5002
- Node gateway — 3001
- Reactive Resume (Docker) — 3000, PostgreSQL (internal)
- MongoDB — 27017

## Run
```bash
# 1) Reactive Resume (self-hosted; RGPD — never the public cloud)
docker compose -f docker-compose.rxresume.yml up -d
#    First boot: open http://localhost:3000 → Settings → API Keys → generate a key.
#    Put it in Backend/cv_tailoring_service/.env as RXRESUME_API_KEY.

# 2) cv-tailoring-service (use the same venv as Backend/server/AI)
cd Backend/cv_tailoring_service
cp .env.example .env   # fill GROQ_API_KEY, RXRESUME_API_KEY
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
| `RXRESUME_API_KEY` | cv-tailoring `.env` | key from RxResume dashboard |
| `MONGO_URI` | cv-tailoring `.env` | `mongodb://localhost:27017/ai_recruiter` |
| `CV_PARSER_URL` | cv-tailoring `.env` | `http://127.0.0.1:5002` |
| `TAILORED_CV_UPLOAD_DIR` | cv-tailoring `.env` | `Backend/server/uploads/tailored-cvs` |
| `CV_TAILORING_SERVICE_URL` | `Backend/server/.env` | `http://localhost:8014` |

## Endpoints
- `POST /api/cv/tailor` `{ jobId }` → tailored JSON + changes + verification (fast, no PDF)
- `POST /api/cv/tailor/export` `{ jobId, cv_json, tailored_cv_json, attach }` → `{ pdf_path, attached }`
- `GET /api/cv/tailored/:applicationId` → tailored CV (candidate or enterprise)

## Open items to finalize (spec §14)
1. Confirm item-level RxResume schema from a populated local export → adjust `app/mapping.py` builders.
2. Pin the exact `amruthpillai/reactive-resume` tag in `docker-compose.rxresume.yml`.
3. Confirm the v4 PDF export endpoint in `app/rxresume_client.py`.
````

- [ ] **Step 4: Commit**

```bash
git add .env.example docs/cv-tailoring/README.md
git commit -m "docs(cv-tailoring): add README and env placeholders"
```
> Do not `git add` `.env` or `Backend/server/.env` — they are gitignored and hold secrets.

---

## Final verification

- [ ] **Python suite:** `cd Backend/cv_tailoring_service && python -m pytest -v` → all PASS.
- [ ] **Node tests:** `node Backend/server/tests/cvTailoring.model.test.js && node Backend/server/tests/cvTailoringService.test.js && node Backend/server/tests/cvTailoringRoute.test.js` → all print `OK`.
- [ ] **Frontend:** `cd Frontend && npm run lint` → clean.
- [ ] **Manual E2E** (per README): tailor → preview + "✅ vérifié" → export PDF → "Utiliser ce CV" attaches to the Application; recruiter can GET it.

## Post-merge follow-ups (spec §14 — require the running local instance)

1. Replace `tests/fixtures/rxresume_base.json` with a **populated** export and finalize the item
   builders in `app/mapping.py`.
2. Pin the exact image tag/digest in `docker-compose.rxresume.yml`.
3. Confirm the PDF export route in `app/rxresume_client.py` (`export_pdf` / `fetch_base_data`).
