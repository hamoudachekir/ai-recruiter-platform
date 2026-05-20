"""Role-Based Access Control — Phase 5.

Defines the RBAC permission matrix and provides FastAPI
dependency for permission enforcement.

ROLE HIERARCHY (descending privilege):
  super_admin > tenant_admin > recruiter > reviewer > analyst > read_only

PERMISSION NAMING CONVENTION:
  resource:action    e.g. "interview:read", "model:train"
"""

from __future__ import annotations

from typing import Optional

from fastapi import HTTPException, Request

# ── Permission sets per role ───────────────────────────────────────────────────

_BASE_READ = {
    "interview:read",
    "report:read",
    "ranking:read",
    "copilot:ask",
}

ROLE_PERMISSIONS: dict[str, set[str]] = {
    "super_admin": {
        *_BASE_READ,
        "interview:analyze",
        "interview:delete",
        "report:export",
        "report:delete",
        "model:train",
        "model:deploy",
        "model:read",
        "candidate:rank",
        "candidate:compare",
        "audit:read",
        "audit:export",
        "tenant:manage",
        "tenant:create",
        "tenant:delete",
        "billing:read",
        "billing:export",
        "ats:sync",
        "ats:configure",
        "review:queue",
        "review:resolve",
        "admin:access",
    },
    "tenant_admin": {
        *_BASE_READ,
        "interview:analyze",
        "report:export",
        "model:train",
        "model:read",
        "candidate:rank",
        "candidate:compare",
        "audit:read",
        "tenant:manage",
        "billing:read",
        "ats:sync",
        "ats:configure",
        "review:queue",
        "review:resolve",
    },
    "recruiter": {
        *_BASE_READ,
        "interview:analyze",
        "report:export",
        "candidate:rank",
        "candidate:compare",
        "review:queue",
    },
    "reviewer": {
        *_BASE_READ,
        "review:queue",
        "review:resolve",
        "audit:read",
    },
    "analyst": {
        *_BASE_READ,
        "report:export",
        "audit:read",
        "model:read",
        "candidate:rank",
    },
    "read_only": {
        *_BASE_READ,
    },
}


def has_permission(role: str, permission: str) -> bool:
    """Check if a role has a specific permission."""
    return permission in ROLE_PERMISSIONS.get(role, set())


def require_permission(permission: str):
    """FastAPI dependency factory for permission-based route guarding.

    Usage:
        @router.get("/...")
        async def endpoint(
            _: None = Depends(require_permission("model:train"))
        ): ...
    """

    async def _check(request: Request):
        ctx = getattr(request.state, "tenant_context", None)
        if not ctx:
            raise HTTPException(status_code=401, detail="Authentication required.")
        if not has_permission(ctx.role, permission):
            raise HTTPException(
                status_code=403,
                detail=f"Role '{ctx.role}' does not have permission '{permission}'.",
            )
        return ctx

    return _check


def audit_action(
    tenant_id: str,
    user_id: str,
    action: str,
    resource: str,
    metadata: Optional[dict] = None,
) -> None:
    """Persist an immutable admin action audit event.

    This is fire-and-forget — failures only log a warning.
    """
    try:
        from datetime import datetime, timezone

        from app.db.mongo import audit_logs_col

        audit_logs_col.insert_one(
            {
                "tenantId": tenant_id,
                "userId": user_id,
                "action": action,
                "resource": resource,
                "metadata": metadata or {},
                "timestamp": datetime.now(timezone.utc),
                "eventType": "admin_action",
                "immutable": True,
            }
        )
    except Exception:  # noqa: BLE001
        import logging

        logging.getLogger(__name__).warning(
            "[RBAC] audit_action persistence failed: %s / %s", action, resource
        )
