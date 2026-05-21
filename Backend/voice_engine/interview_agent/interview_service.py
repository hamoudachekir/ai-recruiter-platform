"""interview_service.py

Manages Nour interview sessions end-to-end:
  - start_session  : build prompt, open session in Redis (or in-memory fallback)
  - send_message   : call LLM, update IRT theta, track stress
  - end_session    : compute final report, write to MongoDB

This is the NEW code path exposed via /api/interview/* routes.
The existing /session/* routes backed by InterviewEngine are unchanged.
"""
from __future__ import annotations

import asyncio
import datetime
import json
import logging
import os
import time
from typing import Any

from .agent_prompt_builder import RoomContext, build_system_prompt
from .agent_state_utils import (
    REPEAT_INSTRUCTION,
    classify_question_type,
    depth_instruction_for_theta,
    format_domain_coverage,
    is_repeat_request,
    stress_instruction_for,
    stress_label_from_level,
    update_domain_coverage,
    variety_instruction,
)
from .irt_engine import (
    QuestionHint,
    compute_stress_level,
    select_question,
    update_theta,
)
from .llm_client import LLMError, build_client_from_env

logger = logging.getLogger(__name__)


# ── Module-level state ────────────────────────────────────────────────────────

_sessions: dict[str, dict] = {}   # in-memory fallback keyed by room_id
_llm_client = None                 # lazy singleton


def _get_llm_client():
    global _llm_client
    if _llm_client is None:
        _llm_client = build_client_from_env()
    return _llm_client


# ── Redis helpers (gracefully degrade to _sessions on any error) ──────────────

_REDIS_KEY_PREFIX = "interview_session:"


async def _redis_get(r, key: str) -> dict | None:
    if r is None:
        return _sessions.get(key)
    try:
        raw = await r.get(key)
        if raw is None:
            return _sessions.get(key)
        return json.loads(raw)
    except Exception:
        return _sessions.get(key)


async def _redis_set(r, key: str, value: dict, ttl_sec: int = 7200) -> None:
    _sessions[key] = value   # always mirror to memory for fallback reads
    if r is None:
        return
    try:
        await r.set(key, json.dumps(value), ex=ttl_sec)
    except Exception:
        pass   # in-memory copy is already up-to-date


# ── LLM response parsing ──────────────────────────────────────────────────────

def _parse_llm_response(payload: dict) -> tuple[float, float, str, str, int, str, bool]:
    """Extract evaluation fields from the LLM JSON response."""
    score         = float(payload.get("score",         0.5))
    confidence    = float(payload.get("confidence",    0.5))
    reasoning     = str  (payload.get("reasoning",     ""))
    next_question = str  (payload.get("next_question", ""))
    difficulty    = int  (payload.get("difficulty",    3))
    skill_focus   = str  (payload.get("skill_focus",   "general"))
    done          = bool (payload.get("done",          False))
    return score, confidence, reasoning, next_question, difficulty, skill_focus, done


_FALLBACK_QUESTIONS = [
    "Can you walk me through a recent project you are proud of?",
    "What is the most challenging technical problem you have solved?",
    "How do you approach learning a new technology or framework?",
    "Describe how you handle disagreements within a team.",
    "What does good code quality mean to you?",
]


# ── MongoDB write (sync, called via asyncio.to_thread) ────────────────────────

def _write_report_to_mongo(report: dict) -> None:
    """Insert the interview report into MongoDB. Never raises."""
    try:
        import pymongo  # lazy import — optional dependency

        mongo_uri = (
            os.getenv("MONGODB_URL")
            or os.getenv("MONGO_URI")
            or "mongodb://localhost:27017"
        )
        db_name = (
            os.getenv("DB_NAME")
            or os.getenv("MONGODB_DATABASE")
            or os.getenv("MONGODB_DB_NAME")
            or os.getenv("MONGO_DB_NAME")
            or "ai_recruiter"
        )

        client = pymongo.MongoClient(mongo_uri, serverSelectionTimeoutMS=5000)
        db = client[db_name]
        db["interview_reports"].insert_one(report)
        client.close()
        logger.info("[interview_service] Report written to MongoDB for room %s", report.get("room_id"))
    except Exception as exc:
        logger.error("[interview_service] MongoDB write failed: %s", exc)


# ── Session helpers ───────────────────────────────────────────────────────────

def _session_key(room_id: str) -> str:
    return f"{_REDIS_KEY_PREFIX}{room_id}"


def _build_fresh_session(
    room_id: str,
    candidate_id: str,
    session_type: str,
    room_data: dict,
    candidate_data: dict,
    preferred_language: str,
) -> dict:
    return {
        "room_id":          room_id,
        "candidate_id":     candidate_id,
        "session_type":     session_type,
        "room_data":        room_data,
        "candidate_data":   candidate_data,
        "theta":            0.0,
        "stress_level":     0.0,
        "struggle_streak":  0,
        "last_confidence":  0.5,
        "turn_index":       0,
        "used_question_ids": [],
        "transcript":       [],
        "evaluations":      [],
        "started_at":       time.time(),
        "ended":            False,
        "preferred_language": preferred_language,
        # ── New stateful fields (issues #1, #3) ───────────────────────────
        # Existing sessions without these still load fine because every
        # read uses .get() with a safe default.
        "domain_coverage":     {},
        "recent_question_types": [],  # tail of QUESTION_TYPES per agent turn
    }


def _session_snapshot(session: dict) -> dict:
    return {
        "room_id":       session["room_id"],
        "session_type":  session["session_type"],
        "turn_index":    session["turn_index"],
        "theta":         round(session["theta"], 3),
        "stress_level":  round(session["stress_level"], 3),
        "done":          session.get("ended", False),
        "agent_message": (
            session["transcript"][-1]["text"]
            if session["transcript"] and session["transcript"][-1]["role"] == "agent"
            else ""
        ),
    }


# ── Public API ────────────────────────────────────────────────────────────────

async def start_session(
    room_id:        str,
    candidate_id:   str,
    session_type:   str,
    room_data:      dict,
    candidate_data: dict,
    _redis=None,
    preferred_language: str = "en",
) -> dict:
    """Initialize a new interview session and return the opening agent message.

    If a non-ended session already exists for this room_id, returns its
    current snapshot instead of creating a duplicate.
    """
    key = _session_key(room_id)
    existing = await _redis_get(_redis, key)
    if existing and not existing.get("ended", False):
        logger.info("[interview_service] Resuming existing session for room %s", room_id)
        return _session_snapshot(existing)

    session = _build_fresh_session(
        room_id, candidate_id, session_type,
        room_data, candidate_data, preferred_language,
    )

    candidate_name = candidate_data.get("name", "there")
    job_title      = room_data.get("job_title", "the role")
    style          = room_data.get("interview_style", "friendly")

    opening_msg = (
        f"Hello {candidate_name}, I'm Nour, your AI interview assistant for TALAN Tunisie. "
        f"Today we are discussing the {job_title} position. "
    )
    if session_type == "intro":
        opening_msg += (
            "This first part is a conversation — no trick questions. "
            "Let's start: could you tell me a little about yourself and what drew you to this role?"
        )
    else:
        opening_msg += (
            "This is the technical part of the interview. "
            "I'll adapt the difficulty based on your responses. Let's begin."
        )

    session["transcript"].append({
        "role": "agent",
        "text": opening_msg,
        "ts":   time.time(),
    })

    await _redis_set(_redis, key, session)
    logger.info("[interview_service] Started %s session for room %s (style=%s)", session_type, room_id, style)

    return {
        "room_id":      room_id,
        "session_type": session_type,
        "turn_index":   0,
        "agent_message": opening_msg,
        "theta":        0.0,
        "stress_level": 0.0,
        "done":         False,
    }


async def send_message(
    room_id:             str,
    candidate_id:        str,
    candidate_message:   str,
    response_time_sec:   float = 0.0,
    sentiment_delta:     float = 0.0,
    _redis=None,
) -> dict:
    """Process one candidate message and return the agent's reply.

    Raises:
        KeyError  — session not found
        ValueError — session has already ended
    """
    key = _session_key(room_id)
    session = await _redis_get(_redis, key)
    if session is None:
        raise KeyError(f"Session not found for room_id={room_id!r}")
    if session.get("ended", False):
        raise ValueError(f"Session for room_id={room_id!r} has already ended")

    # ── Append candidate turn ────────────────────────────────────────────────
    session["transcript"].append({
        "role": "candidate",
        "text": candidate_message,
        "ts":   time.time(),
    })

    # ── Derive sentiment label ───────────────────────────────────────────────
    if sentiment_delta >= 0.1:
        sentiment_label = "POSITIVE"
    elif sentiment_delta <= -0.1:
        sentiment_label = "NEGATIVE"
    else:
        sentiment_label = "NEUTRAL"

    # ── Stress estimation ────────────────────────────────────────────────────
    last_confidence = session.get("last_confidence", 0.5)
    stress, _ = compute_stress_level(
        last_confidence,
        sentiment_label,
        session["struggle_streak"],
    )
    session["stress_level"] = stress
    stress_label_str = stress_label_from_level(stress)

    # ── Domain coverage update (issue #3) ────────────────────────────────────
    # Cheap regex extractor — no extra LLM call. Carries forward existing
    # mentions and grows depth_score when the answer contains trade-off
    # vocabulary. Backward compatible: missing key → {} default.
    session["domain_coverage"] = update_domain_coverage(
        session.get("domain_coverage") or {},
        candidate_message,
    )

    # ── Repeat / clarification detection (issue #5) ─────────────────────────
    repeat_instr = REPEAT_INSTRUCTION if is_repeat_request(candidate_message) else ""

    # ── Variety / rotation (issue #1) ───────────────────────────────────────
    recent_types = session.get("recent_question_types") or []
    variety_text = variety_instruction(recent_types)

    # ── Question hint from IRT engine ────────────────────────────────────────
    hint: QuestionHint | None = select_question(
        theta     = session["theta"],
        style     = session["room_data"].get("interview_style", "friendly"),
        job_title = session["room_data"].get("job_title", ""),
        used_ids  = set(session["used_question_ids"]),
    )

    # ── Build system prompt ──────────────────────────────────────────────────
    ctx = RoomContext(
        room_id           = room_id,
        candidate_id      = candidate_id,
        candidate_name    = session["candidate_data"].get("name", ""),
        job_title         = session["room_data"].get("job_title", ""),
        job_skills        = session["room_data"].get("job_skills", []),
        job_description   = session["room_data"].get("job_description", ""),
        session_type      = session["session_type"],
        interview_style   = session["room_data"].get("interview_style", "friendly"),
        theta             = session["theta"],
        stress_level      = stress,
        turn_index        = session["turn_index"],
        preferred_language= session.get("preferred_language", "en"),
        question_hint     = hint["text"] if hint else "",
        # ── Dynamic injections (issues #1, #2, #3, #4, #5) ─────────────────
        stress_instruction    = stress_instruction_for(stress_label_str),
        depth_instruction     = depth_instruction_for_theta(session["theta"]),
        domain_coverage_block = format_domain_coverage(session["domain_coverage"]),
        variety_block         = variety_text,
        repeat_instruction    = repeat_instr,
    )
    system_prompt = build_system_prompt(ctx)

    # ── Build user message for LLM ───────────────────────────────────────────
    recent = session["transcript"][-12:]   # last 6 turns (12 entries)
    transcript_text = "\n".join(
        f"[{e['role'].upper()}]: {e['text']}" for e in recent
    )
    user_msg = (
        f"CANDIDATE_ANSWER: {candidate_message}\n"
        f"TURN_INDEX: {session['turn_index']}\n"
        f"LAST_SENTIMENT: {sentiment_label}\n"
        f"RESPONSE_TIME_SEC: {response_time_sec:.1f}\n\n"
        f"RECENT_TRANSCRIPT:\n{transcript_text}"
    )

    # ── LLM call ─────────────────────────────────────────────────────────────
    fallback_used = False
    try:
        llm    = _get_llm_client()
        payload: dict[str, Any] = llm.complete_json(
            system      = system_prompt,
            messages    = [{"role": "user", "content": user_msg}],
            temperature = 0.18,
            max_tokens  = 200,
        )
        score, confidence, reasoning, next_question, difficulty, skill_focus, done = (
            _parse_llm_response(payload)
        )
    except (LLMError, Exception) as exc:
        logger.warning("[interview_service] LLM error, using fallback: %s", exc)
        fallback_used = True
        turn_idx      = session["turn_index"]
        next_question = _FALLBACK_QUESTIONS[turn_idx % len(_FALLBACK_QUESTIONS)]
        score         = 0.45
        confidence    = 0.35
        reasoning     = "LLM unavailable — fallback question used"
        difficulty    = 3
        skill_focus   = "general"
        done          = False

    # ── IRT update ───────────────────────────────────────────────────────────
    new_theta = update_theta(session["theta"], score, confidence)
    session["theta"]           = new_theta
    session["last_confidence"] = confidence

    if score < 0.4:
        session["struggle_streak"] += 1
    else:
        session["struggle_streak"] = 0

    # ── Track used question hint ─────────────────────────────────────────────
    if hint is not None:
        session["used_question_ids"].append(hint["id"])

    # ── Track question type for variety rotation (issue #1) ─────────────────
    # We classify what the LLM actually produced (not what we asked it for),
    # since the agent occasionally drifts from the requested shape. Keep
    # only the last 5 entries to bound prompt growth.
    qtype = classify_question_type(next_question)
    recent_types_list = list(session.get("recent_question_types") or [])
    recent_types_list.append(qtype)
    session["recent_question_types"] = recent_types_list[-5:]

    # ── Store evaluation ─────────────────────────────────────────────────────
    session["evaluations"].append({
        "turn_index":   session["turn_index"],
        "score":        round(score, 3),
        "confidence":   round(confidence, 3),
        "stress_level": round(stress, 3),
        "stress_label": stress_label_str,
        "skill_focus":  skill_focus,
        "reasoning":    reasoning,
        "difficulty":   difficulty,
        "fallback":     fallback_used,
        "question_type": qtype,
        # Snapshot the candidate's question + their answer here so downstream
        # report builders can rebuild Q/A pairs even when the live message
        # stream did not reach Mongo.
        "question":          session["transcript"][-2]["text"] if len(session["transcript"]) >= 2 else "",
        "candidate_answer":  candidate_message,
    })

    # ── Append agent turn ────────────────────────────────────────────────────
    session["transcript"].append({
        "role": "agent",
        "text": next_question,
        "ts":   time.time(),
    })

    session["turn_index"] += 1

    await _redis_set(_redis, key, session)

    return {
        "room_id":       room_id,
        "turn_index":    session["turn_index"],
        "agent_message": next_question,
        "scoring": {
            "score":        round(score, 3),
            "confidence":   round(confidence, 3),
            "theta":        round(new_theta, 3),
            "stress_level": round(stress, 3),
            "stress_label": stress_label_str,
            "reasoning":    reasoning,
            "skill_focus":  skill_focus,
            "difficulty":   difficulty,
            "question_type": qtype,
        },
        "done": done,
    }


async def end_session(
    room_id:      str,
    candidate_id: str,
    _redis=None,
) -> dict:
    """Finalize the session, compute final report, and write to MongoDB.

    Raises:
        KeyError — session not found
    """
    key = _session_key(room_id)
    session = await _redis_get(_redis, key)
    if session is None:
        raise KeyError(f"Session not found for room_id={room_id!r}")

    ended_at = time.time()
    session["ended"]    = True
    session["ended_at"] = ended_at
    await _redis_set(_redis, key, session, ttl_sec=3600)   # keep 1 h for debugging

    evals = session.get("evaluations", [])

    def avg(field: str) -> float:
        vals = [e[field] for e in evals if field in e]
        return round(sum(vals) / len(vals), 3) if vals else 0.0

    overall_score      = avg("score")
    overall_confidence = avg("confidence")
    duration_seconds   = ended_at - session.get("started_at", ended_at)

    final_report: dict[str, Any] = {
        "room_id":           room_id,
        "candidate_id":      candidate_id,
        "session_type":      session["session_type"],
        "job_title":         session["room_data"].get("job_title", ""),
        "job_skills":        session["room_data"].get("job_skills", []),
        "job_description":   session["room_data"].get("job_description", ""),
        "interview_style":   session["room_data"].get("interview_style", ""),
        "candidate_name":    session["candidate_data"].get("name", ""),
        "theta_final":       round(session["theta"], 3),
        "stress_level_final": round(session["stress_level"], 3),
        "turn_count":        session["turn_index"],
        "evaluated_answers": len(evals),
        "overall_score":     overall_score,
        "overall_confidence": overall_confidence,
        "evaluations":       evals,
        "transcript":        session["transcript"],
        "started_at":        session.get("started_at"),
        "ended_at":          ended_at,
        "duration_seconds":  round(duration_seconds, 1),
        "created_at":        datetime.datetime.utcnow(),
    }

    await asyncio.to_thread(_write_report_to_mongo, final_report)

    # Remove non-serialisable datetime before returning to client
    client_report = {k: v for k, v in final_report.items() if k != "created_at"}
    return client_report
