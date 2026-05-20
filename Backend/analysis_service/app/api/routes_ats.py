"""Enterprise ATS integration API routes — Phase 5."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

router = APIRouter(prefix="/ats", tags=["ats"])

_SUPPORTED = {"greenhouse", "lever", "workable"}


class AtsPushRequest(BaseModel):
    jobId: str = ""
    candidateId: str = ""


def _credentials_from_config(config, provider: str) -> dict:
    features = (getattr(config, "features", None) or {}) if config else {}
    return {
        "api_key": features.get(f"{provider}_api_key", ""),
        "token": features.get(f"{provider}_token", ""),
        "webhook_secret": features.get(f"{provider}_webhook_secret", ""),
        "subdomain": features.get(f"{provider}_subdomain", ""),
    }


def _provider(provider: str, tenant_id: str, credentials: dict):
    if provider == "greenhouse":
        from app.integrations.base_ats import GreenhouseAtsProvider

        return GreenhouseAtsProvider(tenant_id, credentials)
    if provider == "lever":
        from app.integrations.lever import LeverAtsProvider

        return LeverAtsProvider(tenant_id, credentials)
    if provider == "workable":
        from app.integrations.workable import WorkableAtsProvider

        return WorkableAtsProvider(tenant_id, credentials)
    raise HTTPException(status_code=422, detail=f"Unsupported ATS provider: {provider}")


async def _tenant_credentials(tenant_id: str, provider: str) -> dict:
    from app.services.tenant_service import get_tenant_config

    config = get_tenant_config(tenant_id)
    if not config:
        raise HTTPException(status_code=404, detail="Tenant config not found")
    return _credentials_from_config(config, provider)


@router.post("/webhook/{provider}")
async def ats_webhook(provider: str, request: Request):
    """Receive and verify ATS webhooks."""
    provider = provider.lower()
    if provider not in _SUPPORTED:
        raise HTTPException(status_code=422, detail="Unsupported ATS provider")
    tenant_id = request.headers.get("X-Tenant-ID", "")
    if not tenant_id:
        raise HTTPException(status_code=401, detail="X-Tenant-ID header required")
    body = await request.body()
    signature = (
        request.headers.get("X-Greenhouse-Signature")
        or request.headers.get("X-Lever-Signature")
        or request.headers.get("X-Workable-Signature")
        or request.headers.get("X-Hub-Signature-256")
        or ""
    )
    credentials = await _tenant_credentials(tenant_id, provider)
    ats = _provider(provider, tenant_id, credentials)
    verified = ats.verify_webhook(body, signature)

    from app.db.mongo import ats_sync_logs_col

    ats_sync_logs_col.insert_one(
        {
            "tenantId": tenant_id,
            "provider": provider,
            "operation": "webhook",
            "status": "verified" if verified else "rejected",
            "metadata": {"path": str(request.url.path), "size": len(body)},
        }
    )
    if not verified:
        raise HTTPException(status_code=401, detail="Invalid webhook signature")
    return {"success": True, "provider": provider, "verified": True}


@router.post("/{provider}/push/{interview_id}")
async def push_report(
    provider: str, interview_id: str, payload: AtsPushRequest, request: Request
):
    """Enqueue a retry-safe ATS export job for an interview report."""
    provider = provider.lower()
    if provider not in _SUPPORTED:
        raise HTTPException(status_code=422, detail="Unsupported ATS provider")
    ctx = getattr(request.state, "tenant_context", None)
    if not ctx:
        raise HTTPException(status_code=401, detail="Tenant authentication required")
    from app.workers.queue_config import enqueue_ats_export

    job_id = enqueue_ats_export(
        interview_id=interview_id,
        tenant_id=ctx.tenantId,
        provider=provider,
        job_id_ats=payload.jobId,
        candidate_id=payload.candidateId,
    )
    return {"success": True, "queued": job_id is not None, "jobId": job_id}


@router.get("/{provider}/candidates/{job_id}")
async def sync_candidates(provider: str, job_id: str, request: Request):
    provider = provider.lower()
    if provider not in _SUPPORTED:
        raise HTTPException(status_code=422, detail="Unsupported ATS provider")
    ctx = getattr(request.state, "tenant_context", None)
    if not ctx:
        raise HTTPException(status_code=401, detail="Tenant authentication required")
    credentials = await _tenant_credentials(ctx.tenantId, provider)
    ats = _provider(provider, ctx.tenantId, credentials)
    candidates = await ats.sync_candidates(job_id)
    return {
        "success": True,
        "provider": provider,
        "jobId": job_id,
        "candidates": candidates,
    }


@router.get("/{provider}/jobs")
async def sync_jobs(provider: str, request: Request):
    provider = provider.lower()
    if provider not in _SUPPORTED:
        raise HTTPException(status_code=422, detail="Unsupported ATS provider")
    ctx = getattr(request.state, "tenant_context", None)
    if not ctx:
        raise HTTPException(status_code=401, detail="Tenant authentication required")
    credentials = await _tenant_credentials(ctx.tenantId, provider)
    ats = _provider(provider, ctx.tenantId, credentials)
    jobs = await ats.sync_job_descriptions()
    return {"success": True, "provider": provider, "jobs": jobs}


@router.get("/sync-logs")
async def sync_logs(request: Request, provider: str = "", limit: int = 50):
    ctx = getattr(request.state, "tenant_context", None)
    if not ctx:
        raise HTTPException(status_code=401, detail="Tenant authentication required")
    from app.db.mongo import ats_sync_logs_col
    from app.services.tenant_service import enforce_tenant_filter

    query: dict = {}
    if provider:
        query["provider"] = provider.lower()
    query = enforce_tenant_filter(query, ctx.tenantId)
    logs = list(
        ats_sync_logs_col.find(query, {"_id": 0}).sort("timestamp", -1).limit(limit)
    )
    return {"success": True, "logs": logs, "count": len(logs)}
