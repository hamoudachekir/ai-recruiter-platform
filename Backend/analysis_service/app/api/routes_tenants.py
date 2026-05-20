"""Tenant Management API Routes — Phase 5.

POST /tenants                    Create a new tenant (super_admin)
GET  /tenants                    List all tenants (super_admin)
GET  /tenants/{tenant_id}        Get tenant info
PUT  /tenants/{tenant_id}/config Update tenant configuration
GET  /tenants/{tenant_id}/usage  Get billing usage
GET  /tenants/{tenant_id}/models List available models
"""

from __future__ import annotations

from typing import Optional

from app.models.tenant_models import TenantConfigUpdateRequest, TenantCreateRequest
from fastapi import APIRouter, Depends, HTTPException, Request

router = APIRouter(prefix="/tenants", tags=["tenants"])


@router.post("")
async def create_tenant(payload: TenantCreateRequest, request: Request):
    """Create a new tenant. Requires super_admin role."""
    from app.security.rbac import require_permission

    ctx = getattr(request.state, "tenant_context", None)
    if not ctx or ctx.role != "super_admin":
        raise HTTPException(status_code=403, detail="super_admin role required.")
    from app.services.tenant_service import create_tenant as _create

    return _create(
        organization_name=payload.organizationName,
        admin_email=payload.adminEmail,
        scoring_mode=payload.scoringMode,
        ats_provider=payload.atsProvider,
    )


@router.get("")
async def list_tenants(request: Request):
    """List all tenants. Requires super_admin role."""
    ctx = getattr(request.state, "tenant_context", None)
    if not ctx or ctx.role != "super_admin":
        raise HTTPException(status_code=403, detail="super_admin role required.")
    from app.services.tenant_service import list_tenants as _list

    return {"success": True, "tenants": _list()}


@router.get("/{tenant_id}")
async def get_tenant(tenant_id: str, request: Request):
    """Get tenant config. Tenant admins can only access their own."""
    ctx = getattr(request.state, "tenant_context", None)
    if not ctx:
        raise HTTPException(status_code=401, detail="Authentication required.")
    if ctx.role != "super_admin" and ctx.tenantId != tenant_id:
        raise HTTPException(status_code=403, detail="Access denied.")
    from app.services.tenant_service import get_tenant_config

    config = get_tenant_config(tenant_id)
    if not config:
        raise HTTPException(status_code=404, detail=f"Tenant {tenant_id} not found.")
    return {"success": True, "config": config.dict(exclude_none=True)}


@router.put("/{tenant_id}/config")
async def update_tenant_config(
    tenant_id: str, payload: TenantConfigUpdateRequest, request: Request
):
    """Update tenant configuration."""
    ctx = getattr(request.state, "tenant_context", None)
    if not ctx:
        raise HTTPException(status_code=401, detail="Authentication required.")
    if ctx.role not in ("super_admin", "tenant_admin") or (
        ctx.role == "tenant_admin" and ctx.tenantId != tenant_id
    ):
        raise HTTPException(status_code=403, detail="Access denied.")
    from app.services.tenant_service import update_tenant_config

    updates = payload.dict(exclude_none=True)
    return update_tenant_config(tenant_id, updates)


@router.get("/{tenant_id}/usage")
async def tenant_usage(tenant_id: str, request: Request, period: str = "current_month"):
    """Get billing usage for a tenant."""
    ctx = getattr(request.state, "tenant_context", None)
    if not ctx:
        raise HTTPException(status_code=401, detail="Authentication required.")
    if (
        ctx.role not in ("super_admin", "tenant_admin", "analyst")
        and ctx.tenantId != tenant_id
    ):
        raise HTTPException(status_code=403, detail="Access denied.")
    from app.services.billing_metering_service import get_usage_summary

    return get_usage_summary(tenant_id=tenant_id, period=period)


@router.get("/{tenant_id}/models")
async def tenant_models(tenant_id: str, request: Request):
    """List ML models available for a tenant."""
    ctx = getattr(request.state, "tenant_context", None)
    if not ctx:
        raise HTTPException(status_code=401, detail="Authentication required.")
    from app.ml_models.tenant_model_registry.registry import (
        get_metadata_for_tenant,
        list_tenants_with_models,
    )

    has_own = tenant_id in list_tenants_with_models()
    meta = get_metadata_for_tenant(tenant_id)
    return {
        "success": True,
        "tenantId": tenant_id,
        "hasTenantSpecificModel": has_own,
        "activeModelMetadata": meta,
    }
