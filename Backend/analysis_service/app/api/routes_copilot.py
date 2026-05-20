"""Recruiter Copilot API Routes — Phase 5.

POST /copilot/interview/{interview_id}/ask   Ask a question about an interview
GET  /copilot/interview/{interview_id}/summary  Quick evidence summary
GET  /copilot/session/{session_id}           Retrieve session history
"""

from __future__ import annotations

from fastapi import APIRouter, Request
from pydantic import BaseModel

router = APIRouter(prefix="/copilot", tags=["copilot"])


class CopilotAskRequest(BaseModel):
    question: str
    sessionId: str = ""


@router.post("/interview/{interview_id}/ask")
async def copilot_ask(interview_id: str, payload: CopilotAskRequest, request: Request):
    """Ask a natural-language question about an interview.
    Answers are grounded exclusively in Phase 3 evidence."""
    from app.services.recruiter_copilot_service import ask_copilot

    ctx = getattr(request.state, "tenant_context", None)
    tenant_id = ctx.tenantId if ctx else ""
    return ask_copilot(
        interview_id=interview_id,
        question=payload.question,
        tenant_id=tenant_id,
        session_id=payload.sessionId,
    )


@router.get("/interview/{interview_id}/summary")
async def copilot_summary(interview_id: str, request: Request):
    """Return a structured summary of all key evidence for an interview."""
    from app.services.recruiter_copilot_service import ask_copilot

    ctx = getattr(request.state, "tenant_context", None)
    tenant_id = ctx.tenantId if ctx else ""
    return ask_copilot(
        interview_id=interview_id,
        question="Summarize the key evidence for this candidate.",
        tenant_id=tenant_id,
    )


@router.get("/session/{session_id}")
async def copilot_session(session_id: str, request: Request, limit: int = 20):
    """Retrieve copilot conversation history for a session."""
    from app.db.mongo import db

    copilot_sessions_col = db["copilot_sessions"]
    ctx = getattr(request.state, "tenant_context", None)
    tenant_id = ctx.tenantId if ctx else ""
    query: dict = {"sessionId": session_id}
    if tenant_id:
        query["tenantId"] = tenant_id
    events = list(
        copilot_sessions_col.find(query, {"_id": 0})
        .sort("generatedAt", -1)
        .limit(limit)
    )
    return {
        "success": True,
        "sessionId": session_id,
        "events": events,
        "count": len(events),
    }
