"""FastAPI service for the adaptive interview agent."""
from __future__ import annotations

import os
from typing import Literal, Optional

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from .interview_engine import InterviewEngine
from .llm_client import LLMError, build_client_from_env
from ..comparison_agent import ComparisonEngine
from . import interview_service as _isvc

# Load env in this order so the repo-root .env (where real secrets live) wins
# over any scaffolded local .env. Without this, a placeholder NVIDIA_API_KEY
# in interview_agent/.env shadows the real key in the repo root.
_CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(_CURRENT_DIR)))
load_dotenv(os.path.join(_CURRENT_DIR, ".env"), override=False)
load_dotenv(os.path.join(_REPO_ROOT, ".env"), override=True)

app = FastAPI(title="Interview Agent API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://localhost:3000",
        "http://127.0.0.1:5173",
        "http://127.0.0.1:3000",
    ],
    allow_origin_regex=r"^http://(localhost|127\.0\.0\.1)(:\d+)?$",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

engine: Optional[InterviewEngine] = None
comparison_engine: Optional[ComparisonEngine] = None
startup_error: Optional[str] = None
_redis = None   # redis.asyncio.Redis instance, or None if unavailable


@app.on_event("startup")
async def _startup_redis() -> None:
    global _redis
    try:
        import redis.asyncio as aioredis
        _redis = aioredis.from_url(
            os.getenv("REDIS_URL", "redis://localhost:6379"),
            decode_responses=False,
            socket_connect_timeout=2,
        )
        await _redis.ping()
    except Exception:
        _redis = None   # graceful degradation — in-memory fallback in interview_service


@app.on_event("startup")
def _startup() -> None:
    global engine, comparison_engine, startup_error
    try:
        client = build_client_from_env()
        engine = InterviewEngine(client)
        # Share the same LLM client between live-interview turns and the
        # batch-style comparison ranker. Cheaper than spinning a second client
        # and keeps provider settings (Groq, NVIDIA, Anthropic, …) in sync.
        comparison_engine = ComparisonEngine(client)
        startup_error = None
    except LLMError as exc:
        engine = None
        comparison_engine = None
        startup_error = str(exc)


def _require_engine() -> InterviewEngine:
    if engine is None:
        detail = "Interview engine not ready."
        if startup_error:
            detail += f" Startup error: {startup_error}"
        raise HTTPException(status_code=503, detail=detail)
    return engine


# ---------- schemas ----------


class StartRequest(BaseModel):
    interview_id: str = Field(..., min_length=1, max_length=200)
    job_title: str = ""
    job_skills: list[str] = Field(default_factory=list)
    job_description: str = ""
    candidate_name: str = ""
    candidate_profile: dict = Field(default_factory=dict)
    interview_style: str = Field("friendly", max_length=40)
    # Accepts the 5 interview phases plus the legacy "intro"/"technical" buckets
    # (mapped to "introduction"/"technical" by the engine).
    phase: Literal[
        "introduction", "experience", "technical", "behavioral", "closing", "intro"
    ] = "intro"
    preferred_language: str = Field("en", max_length=20)
    # Rich job configuration assembled upstream so every question is generated
    # dynamically from the full job (company context, seniority, criteria, ...).
    job_context: str = Field("", max_length=6000)
    seniority: str = Field("", max_length=40)
    # Structured evaluation criteria [{name, weight}] for weighted final scoring.
    evaluation_criteria: list[dict] = Field(default_factory=list)


class TurnRequest(BaseModel):
    interview_id: str
    text: str = Field(..., min_length=1, max_length=5000)
    sentiment: dict | None = None
    preferred_language: str | None = Field(None, max_length=20)


class SwitchRequest(BaseModel):
    interview_id: str
    phase: Literal[
        "introduction", "experience", "technical", "behavioral", "closing", "intro"
    ]


class EndRequest(BaseModel):
    interview_id: str


class CandidatePayload(BaseModel):
    sessionId: str
    candidateId: Optional[str] = None
    candidateName: str = ""
    candidateEmail: str = ""
    metrics: dict = Field(default_factory=dict)


class ComparisonRankRequest(BaseModel):
    job: dict = Field(default_factory=dict)
    candidates: list[CandidatePayload]


class InterviewStartReq(BaseModel):
    room_id: str = Field(..., min_length=1, max_length=200)
    candidate_id: str = Field(..., min_length=1, max_length=200)
    session_type: Literal["intro", "technical"] = "intro"
    job_title: str = ""
    job_skills: list[str] = Field(default_factory=list)
    job_description: str = ""
    interview_style: str = Field("friendly", max_length=40)
    candidate_name: str = ""
    candidate_profile: dict = Field(default_factory=dict)
    preferred_language: str = Field("en", max_length=20)


class InterviewMessageReq(BaseModel):
    room_id: str = Field(..., min_length=1, max_length=200)
    candidate_id: str = Field(..., min_length=1, max_length=200)
    message: str = Field(..., min_length=1, max_length=5000)
    response_time_sec: float = 0.0
    sentiment_delta: float = 0.0   # -1.0 to 1.0


class InterviewEndReq(BaseModel):
    room_id: str = Field(..., min_length=1, max_length=200)
    candidate_id: str = Field(..., min_length=1, max_length=200)


# ---------- routes ----------


@app.get("/health")
def health() -> dict:
    return {
        "status": "ok" if engine is not None else "error",
        "ready": engine is not None,
        "provider": os.getenv("LLM_PROVIDER", "echo"),
        "interview_styles": ["friendly", "strict", "senior", "junior", "fast_screening"],
        "error": startup_error,
        "new_interview_routes": [
            "/api/interview/start",
            "/api/interview/message",
            "/api/interview/end",
        ],
    }


@app.post("/session/start")
def session_start(req: StartRequest) -> dict:
    eng = _require_engine()
    try:
        return eng.start(
            req.interview_id,
            job_title=req.job_title,
            job_skills=req.job_skills,
            job_description=req.job_description,
            candidate_name=req.candidate_name,
            candidate_profile=req.candidate_profile,
            interview_style=req.interview_style,
            phase=req.phase,
            preferred_language=req.preferred_language,
            job_context=req.job_context,
            seniority=req.seniority,
            evaluation_criteria=req.evaluation_criteria,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/session/turn")
def session_turn(req: TurnRequest) -> dict:
    eng = _require_engine()
    try:
        return eng.candidate_turn(
            req.interview_id,
            text=req.text,
            sentiment=req.sentiment,
            preferred_language=req.preferred_language,
        )
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/session/switch")
def session_switch(req: SwitchRequest) -> dict:
    eng = _require_engine()
    try:
        return eng.switch_phase(req.interview_id, req.phase)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/session/end")
def session_end(req: EndRequest) -> dict:
    eng = _require_engine()
    try:
        return eng.end(req.interview_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.post("/comparison/rank")
def comparison_rank(req: ComparisonRankRequest) -> dict:
    if comparison_engine is None:
        detail = "Comparison engine not ready."
        if startup_error:
            detail += f" Startup error: {startup_error}"
        raise HTTPException(status_code=503, detail=detail)
    try:
        return comparison_engine.rank(
            req.job,
            [c.model_dump() for c in req.candidates],
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except LLMError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/session/{interview_id}")
def session_get(interview_id: str) -> dict:
    eng = _require_engine()
    try:
        return eng.get(interview_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


# ── Nour interview service routes → Cyriness (/api/interview/*) ─────────────────────────
# New code path using interview_service.py (Redis-backed, IRT-aware).
# Existing /session/* routes backed by InterviewEngine are unchanged.


@app.post("/api/interview/start")
async def api_interview_start(req: InterviewStartReq) -> dict:
    try:
        return await _isvc.start_session(
            room_id        = req.room_id,
            candidate_id   = req.candidate_id,
            session_type   = req.session_type,
            room_data      = {
                "job_title":        req.job_title,
                "job_skills":       req.job_skills,
                "job_description":  req.job_description,
                "interview_style":  req.interview_style,
            },
            candidate_data = {
                "name":    req.candidate_name,
                "profile": req.candidate_profile,
            },
            _redis             = _redis,
            preferred_language = req.preferred_language,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/interview/message")
async def api_interview_message(req: InterviewMessageReq) -> dict:
    try:
        return await _isvc.send_message(
            room_id           = req.room_id,
            candidate_id      = req.candidate_id,
            candidate_message = req.message,
            response_time_sec = req.response_time_sec,
            sentiment_delta   = req.sentiment_delta,
            _redis            = _redis,
        )
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/interview/end")
async def api_interview_end(req: InterviewEndReq) -> dict:
    try:
        return await _isvc.end_session(
            room_id      = req.room_id,
            candidate_id = req.candidate_id,
            _redis       = _redis,
        )
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("AGENT_PORT", "8013"))
    uvicorn.run(app, host="0.0.0.0", port=port, reload=False)
