"""Tenant Management Service — Phase 5.

Handles:
  - Tenant creation and onboarding
  - Tenant configuration CRUD
  - Tenant isolation enforcement
  - API key management

ISOLATION RULE: enforce_tenant_filter() MUST be called before any
cross-tenant-sensitive query. Violations are logged as CRITICAL.
"""

from __future__ import annotations

import hashlib
import logging
import secrets
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from app.db.mongo import tenant_configs_col, tenants_col
from app.models.tenant_models import TenantConfig, TenantContext

_LOG = logging.getLogger(__name__)


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


# ── Tenant isolation ──────────────────────────────────────────────────────────


def enforce_tenant_filter(
    query: dict,
    tenant_id: str,
    field: str = "tenantId",
) -> dict:
    """Inject tenantId into a MongoDB query dict and return it.

    CRITICAL: This must be called before any query that touches tenant data.
    If tenant_id is empty the violation is logged and the query is blocked
    by injecting an impossible filter.

    Args:
        query:     The MongoDB query to augment.
        tenant_id: The current tenant's ID.
        field:     The field name for tenant scoping (default: "tenantId").

    Returns:
        The query dict with the tenant filter added.
    """
    if not tenant_id:
        _LOG.critical(
            "[TenantIsolation] VIOLATION: enforce_tenant_filter called with empty "
            "tenant_id — injecting impossible filter to prevent cross-tenant leak."
        )
        return {**query, field: "__IMPOSSIBLE_TENANT_ID__"}

    existing = query.get(field)
    if existing and existing != tenant_id:
        _LOG.critical(
            "[TenantIsolation] VIOLATION: query already has %s=%r but context "
            "says tenantId=%r — overriding to prevent cross-tenant leak.",
            field,
            existing,
            tenant_id,
        )

    return {**query, field: tenant_id}


def tag_document(doc: dict, tenant_ctx: TenantContext) -> dict:
    """Add tenantId and organizationId to a document before inserting."""
    return {
        **doc,
        "tenantId": tenant_ctx.tenantId,
        "organizationId": tenant_ctx.organizationId,
    }


# ── Tenant CRUD ───────────────────────────────────────────────────────────────


def create_tenant(
    organization_name: str,
    admin_email: str,
    scoring_mode: str = "deterministic",
    ats_provider: Optional[str] = None,
) -> dict:
    """Create a new tenant with a generated API key and default config.

    Returns:
        dict with tenantId, organizationId, apiKey, success
    """
    try:
        if scoring_mode not in {"deterministic", "hybrid", "shadow"}:
            scoring_mode = "deterministic"

        tenant_id = f"tenant_{uuid.uuid4().hex[:12]}"
        org_id = f"org_{uuid.uuid4().hex[:12]}"
        api_key = _generate_api_key(tenant_id)
        now = _utc_now()

        tenant_doc = {
            "tenantId": tenant_id,
            "organizationId": org_id,
            "organizationName": organization_name,
            "adminEmail": admin_email,
            "apiKey": api_key,
            "defaultRole": "recruiter",
            "status": "active",
            "createdAt": now,
            "updatedAt": now,
        }
        tenants_col.insert_one(tenant_doc)

        config_doc = TenantConfig(
            tenantId=tenant_id,
            organizationId=org_id,
            organizationName=organization_name,
            scoringMode=scoring_mode,  # type: ignore[arg-type]
            mlEnabled=False,
            reviewThreshold=0.40,
            biasSensitivity="medium",
            atsProvider=ats_provider,
            createdAt=now,
            updatedAt=now,
        ).dict()
        tenant_configs_col.insert_one(config_doc)

        _LOG.info("[TenantService] Created tenant=%s org=%s", tenant_id, org_id)
        return {
            "success": True,
            "tenantId": tenant_id,
            "organizationId": org_id,
            "apiKey": api_key,
            "message": f"Tenant created for {organization_name}",
        }
    except Exception as exc:  # noqa: BLE001
        _LOG.error("[TenantService] create_tenant failed: %s", exc)
        return {"success": False, "message": str(exc)}


def get_tenant_config(tenant_id: str) -> Optional[TenantConfig]:
    """Load tenant configuration from MongoDB."""
    try:
        doc = tenant_configs_col.find_one({"tenantId": tenant_id}, {"_id": 0})
        if not doc:
            return None
        return TenantConfig(**doc)
    except Exception as exc:  # noqa: BLE001
        _LOG.error("[TenantService] get_tenant_config failed: %s", exc)
        return None


def update_tenant_config(tenant_id: str, updates: dict[str, Any]) -> dict:
    """Update specific fields in a tenant's configuration."""
    try:
        updates["updatedAt"] = _utc_now()
        tenant_configs_col.update_one(
            {"tenantId": tenant_id},
            {"$set": updates},
            upsert=False,
        )
        return {"success": True, "tenantId": tenant_id}
    except Exception as exc:  # noqa: BLE001
        _LOG.error("[TenantService] update_tenant_config failed: %s", exc)
        return {"success": False, "message": str(exc)}


def enrich_context_with_config(ctx: TenantContext) -> TenantContext:
    """Load and attach tenant config to the context (lazy loading)."""
    if ctx.config is None:
        ctx = TenantContext(**{**ctx.dict(), "config": get_tenant_config(ctx.tenantId)})
    return ctx


def list_tenants(limit: int = 50) -> list[dict]:
    """List all tenants (super_admin only)."""
    try:
        docs = list(tenants_col.find({}, {"_id": 0, "apiKey": 0}).limit(limit))
        return docs
    except Exception as exc:  # noqa: BLE001
        _LOG.error("[TenantService] list_tenants failed: %s", exc)
        return []


def _generate_api_key(tenant_id: str) -> str:
    """Generate a secure, non-reversible API key."""
    raw = f"{tenant_id}:{secrets.token_hex(32)}"
    return f"nk_{hashlib.sha256(raw.encode()).hexdigest()[:40]}"
