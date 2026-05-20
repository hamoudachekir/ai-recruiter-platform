"""Tenant domain models — Phase 5.

Pydantic models for multi-tenant SaaS layer.
Every entity in the system carries tenantId + organizationId.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field

# ── Tenant Config ─────────────────────────────────────────────────────────────


class TenantBranding(BaseModel):
    companyName: str = ""
    logoUrl: str = ""
    primaryColor: str = "#2563EB"
    reportHeader: str = ""


class TenantConfig(BaseModel):
    """Per-tenant operational configuration.

    Stored in tenant_configs collection.
    Controls scoring behaviour, ML activation, review thresholds.
    """

    tenantId: str
    organizationId: str
    organizationName: str = ""

    # Scoring + ML
    scoringMode: Literal["deterministic", "hybrid", "shadow"] = "deterministic"
    mlEnabled: bool = False
    reviewThreshold: float = Field(0.40, ge=0.0, le=1.0)
    biasSensitivity: Literal["low", "medium", "high"] = "medium"

    # Integrations
    atsProvider: Optional[str] = None  # "greenhouse" | "lever" | "workable" | None
    atsWebhookSecret: Optional[str] = None

    # Ranking weights (must sum to 1.0 — enforced at application layer)
    rankingWeights: dict[str, float] = Field(
        default_factory=lambda: {
            "overallScore": 0.35,
            "jobMatchScore": 0.30,
            "evidenceCoverage": 0.15,
            "confidence": 0.10,
            "biasPenalty": 0.10,
        }
    )

    # UI / reporting
    branding: TenantBranding = Field(default_factory=TenantBranding)
    features: dict[str, Any] = Field(default_factory=dict)

    createdAt: Optional[datetime] = None
    updatedAt: Optional[datetime] = None

    class Config:
        extra = "allow"


# ── Request-scoped tenant context ─────────────────────────────────────────────


class TenantContext(BaseModel):
    """Injected into request.state by TenantMiddleware.

    Available to all route handlers and service functions
    that need tenant-aware behaviour.
    """

    tenantId: str
    organizationId: str
    userId: str = ""
    role: str = "read_only"  # matches RBAC role names
    config: Optional[TenantConfig] = None

    class Config:
        arbitrary_types_allowed = True

    def has_permission(self, permission: str) -> bool:
        """Delegate to RBAC check (imported lazily to avoid circular deps)."""
        from app.security.rbac import ROLE_PERMISSIONS

        return permission in ROLE_PERMISSIONS.get(self.role, set())


# ── API request/response helpers ──────────────────────────────────────────────


class TenantCreateRequest(BaseModel):
    organizationName: str
    adminEmail: str
    scoringMode: Literal["deterministic", "hybrid", "shadow"] = "deterministic"
    atsProvider: Optional[str] = None


class TenantCreateResponse(BaseModel):
    success: bool
    tenantId: str
    organizationId: str
    apiKey: str
    message: str


class TenantConfigUpdateRequest(BaseModel):
    scoringMode: Optional[Literal["deterministic", "hybrid", "shadow"]] = None
    mlEnabled: Optional[bool] = None
    reviewThreshold: Optional[float] = None
    biasSensitivity: Optional[Literal["low", "medium", "high"]] = None
    atsProvider: Optional[str] = None
    rankingWeights: Optional[dict[str, float]] = None
    branding: Optional[TenantBranding] = None
    features: Optional[dict[str, Any]] = None
