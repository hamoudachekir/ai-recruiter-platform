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
startup_error: Optional[str] = None


@app.on_event("startup")
def _startup() -> None:
    global engine, startup_error
    try:
        engine = InterviewEngine(build_client_from_env())
        startup_error = None
    except LLMError as exc:
        engine = None
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
    phase: Literal["intro", "technical"] = "intro"


class TurnRequest(BaseModel):
    interview_id: str
    text: str = Field(..., min_length=1, max_length=5000)
    sentiment: dict | None = None


class SwitchRequest(BaseModel):
    interview_id: str
    phase: Literal["intro", "technical"]


class EndRequest(BaseModel):
    interview_id: str


# ---------- routes ----------


@app.get("/health")
def health() -> dict:
    return {
        "status": "ok" if engine is not None else "error",
        "ready": engine is not None,
        "provider": os.getenv("LLM_PROVIDER", "echo"),
        "interview_styles": ["friendly", "strict", "senior", "junior", "fast_screening"],
        "error": startup_error,
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
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/session/turn")
def session_turn(req: TurnRequest) -> dict:
    eng = _require_engine()
    try:
        return eng.candidate_turn(
            req.interview_id, text=req.text, sentiment=req.sentiment
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


@app.get("/session/{interview_id}")
def session_get(interview_id: str) -> dict:
    eng = _require_engine()
    try:
        return eng.get(interview_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("AGENT_PORT", "8013"))
    uvicorn.run(app, host="0.0.0.0", port=port, reload=False)
