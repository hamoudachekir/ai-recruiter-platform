"""Candidate Ranking API Routes — Phase 5.

POST /ranking/job/{job_id}               Rank candidates for a job
GET  /ranking/job/{job_id}/leaderboard   Latest ranking leaderboard
GET  /ranking/job/{job_id}/audit         Ranking audit history
"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

router = APIRouter(prefix="/ranking", tags=["ranking"])


class RankingRequest(BaseModel):
    interviewIds: list[str]
    weights: Optional[dict[str, float]] = None
    humanScores: Optional[dict[str, float]] = None


@router.post("/job/{job_id}")
async def rank_candidates(job_id: str, payload: RankingRequest, request: Request):
    """Rank candidates for a job opening deterministically."""
    if len(payload.interviewIds) > 200:
        raise HTTPException(
            status_code=422, detail="Maximum 200 candidates per ranking."
        )
    from app.services.ranking_service import rank_candidates_for_job

    ctx = getattr(request.state, "tenant_context", None)
    tenant_id = ctx.tenantId if ctx else ""
    return rank_candidates_for_job(
        job_id=job_id,
        candidate_interview_ids=payload.interviewIds,
        tenant_id=tenant_id,
        weights=payload.weights,
        human_scores=payload.humanScores,
    )


@router.get("/job/{job_id}/leaderboard")
async def get_leaderboard(job_id: str, request: Request):
    """Return the most recent ranking leaderboard for a job."""
    from app.services.ranking_service import get_ranking_for_job

    ctx = getattr(request.state, "tenant_context", None)
    tenant_id = ctx.tenantId if ctx else ""
    result = get_ranking_for_job(job_id=job_id, tenant_id=tenant_id)
    if not result:
        raise HTTPException(
            status_code=404, detail=f"No ranking found for jobId={job_id}"
        )
    return result


@router.get("/job/{job_id}/audit")
async def ranking_audit(job_id: str, request: Request, limit: int = 10):
    """Return ranking history for audit purposes."""
    from app.db.mongo import db

    ranking_results_col = db["ranking_results"]
    ctx = getattr(request.state, "tenant_context", None)
    tenant_id = ctx.tenantId if ctx else ""
    query: dict = {"jobId": job_id}
    if tenant_id:
        query["tenantId"] = tenant_id
    history = list(
        ranking_results_col.find(query, {"_id": 0, "rankings": 0})
        .sort("createdAt", -1)
        .limit(limit)
    )
    return {"success": True, "jobId": job_id, "history": history}
