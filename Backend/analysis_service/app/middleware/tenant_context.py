"""Tenant Context Middleware — Phase 5.

Resolves tenant identity on every request from:
  1. JWT Authorization header (Bearer token)
  2. X-API-Key header
  3. X-Tenant-ID + X-Organization-ID headers (internal service calls)

Injects TenantContext into request.state.tenant_context.

DESIGN RULES:
- Never blocks requests that lack tenant context — enforcement is at the
  route/dependency level, not here.
- JWT decoding is best-effort; missing/invalid tokens produce no context.
- All errors are logged at DEBUG level only (no production noise).
- This middleware NEVER modifies response bodies.
"""

from __future__ import annotations

import logging
import os
from typing import Optional

from fastapi import Request
from starlette.middleware.base import BaseHTTPMiddleware

from app.models.tenant_models import TenantContext

_LOG = logging.getLogger(__name__)

_JWT_SECRET = os.getenv("JWT_SECRET", "")
_JWT_ALGORITHM = os.getenv("JWT_ALGORITHM", "HS256")


class TenantContextMiddleware(BaseHTTPMiddleware):
    """Soft tenant resolution middleware.

    Sets request.state.tenant_context when a valid tenant identity is found.
    Does NOT block requests with missing identity (enforcement is at routes).
    """

    async def dispatch(self, request: Request, call_next):
        request.state.tenant_context = None

        ctx = await self._resolve(request)
        if ctx:
            request.state.tenant_context = ctx
            _LOG.debug(
                "[TenantMiddleware] Resolved tenantId=%s role=%s path=%s",
                ctx.tenantId,
                ctx.role,
                request.url.path,
            )

        return await call_next(request)

    async def _resolve(self, request: Request) -> Optional[TenantContext]:
        # ── Strategy 1: Internal header bypass (service-to-service) ─────
        tenant_header = request.headers.get("X-Tenant-ID")
        org_header = request.headers.get("X-Organization-ID")
        if tenant_header and org_header:
            return TenantContext(
                tenantId=tenant_header,
                organizationId=org_header,
                userId=request.headers.get("X-User-ID", ""),
                role=request.headers.get("X-User-Role", "read_only"),
            )

        # ── Strategy 2: JWT Bearer token ──────────────────────────────────
        auth = request.headers.get("Authorization", "")
        if auth.startswith("Bearer ") and _JWT_SECRET:
            ctx = self._decode_jwt(auth[7:])
            if ctx:
                return ctx

        # ── Strategy 3: API key lookup ────────────────────────────────────
        api_key = request.headers.get("X-API-Key", "")
        if api_key:
            ctx = await self._resolve_api_key(api_key)
            if ctx:
                return ctx

        return None

    def _decode_jwt(self, token: str) -> Optional[TenantContext]:
        try:
            pyjwt = __import__("jwt")  # PyJWT

            payload = pyjwt.decode(token, _JWT_SECRET, algorithms=[_JWT_ALGORITHM])
            tenant_id = payload.get("tenantId") or payload.get("tenant_id", "")
            org_id = payload.get("organizationId") or payload.get("org_id", "")
            if not tenant_id:
                return None
            return TenantContext(
                tenantId=tenant_id,
                organizationId=org_id,
                userId=payload.get("sub") or payload.get("userId", ""),
                role=payload.get("role", "read_only"),
            )
        except Exception as exc:  # noqa: BLE001
            _LOG.debug("[TenantMiddleware] JWT decode failed: %s", exc)
            return None

    async def _resolve_api_key(self, api_key: str) -> Optional[TenantContext]:
        try:
            from app.db.mongo import tenants_col

            record = tenants_col.find_one({"apiKey": api_key}, {"_id": 0})
            if not record:
                return None
            return TenantContext(
                tenantId=record["tenantId"],
                organizationId=record.get("organizationId", record["tenantId"]),
                userId="api_key_user",
                role=record.get("defaultRole", "recruiter"),
            )
        except Exception as exc:  # noqa: BLE001
            _LOG.debug("[TenantMiddleware] API key lookup failed: %s", exc)
            return None


# ── FastAPI dependency ─────────────────────────────────────────────────────────


def get_tenant_context(request: Request) -> Optional[TenantContext]:
    """FastAPI dependency — returns the tenant context or None."""
    return getattr(request.state, "tenant_context", None)


def require_tenant_context(request: Request) -> TenantContext:
    """FastAPI dependency — raises 401 if no tenant context."""
    from fastapi import HTTPException

    ctx = getattr(request.state, "tenant_context", None)
    if not ctx:
        raise HTTPException(status_code=401, detail="Tenant authentication required.")
    return ctx
