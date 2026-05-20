"""Lever ATS provider implementation."""

from __future__ import annotations

import hashlib
import hmac
import logging
from typing import Optional

import httpx

from app.integrations.base_ats import BaseAtsProvider

_LOG = logging.getLogger(__name__)


class LeverAtsProvider(BaseAtsProvider):
    """Lever ATS integration using bearer-token auth."""

    provider_name = "lever"
    base_url = "https://api.lever.co/v1"

    def _headers(self) -> dict[str, str]:
        token = self.credentials.get("api_key") or self.credentials.get("token") or ""
        return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}

    async def push_interview_report(
        self, report: dict, job_id: str, candidate_id: str
    ) -> dict:
        if not self.credentials.get("api_key") and not self.credentials.get("token"):
            self._log_sync("push_report", "failed", {"reason": "missing_api_key"})
            return {"success": False, "error": "Missing Lever API token"}
        payload = {"value": _map_report_to_lever_note(report)}
        async with httpx.AsyncClient(timeout=20.0) as client:
            resp = await client.post(
                f"{self.base_url}/candidates/{candidate_id}/notes",
                headers=self._headers(),
                json=payload,
            )
        self._log_sync(
            "push_report",
            "success" if resp.is_success else "failed",
            {"statusCode": resp.status_code},
        )
        lever_id = ""
        try:
            lever_id = (resp.json() or {}).get("data", {}).get("id", "")
        except Exception:  # noqa: BLE001
            pass
        return {
            "success": resp.is_success,
            "statusCode": resp.status_code,
            "leverId": lever_id,
        }

    async def sync_candidates(self, job_id: Optional[str] = None) -> list[dict]:
        if not self.credentials.get("api_key") and not self.credentials.get("token"):
            _LOG.warning("[Lever] Missing API token for tenant=%s", self.tenant_id)
            return []
        params = {"posting_id": job_id} if job_id else {}
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.get(
                f"{self.base_url}/opportunities", headers=self._headers(), params=params
            )
        if not resp.is_success:
            self._log_sync(
                "sync_candidates", "failed", {"statusCode": resp.status_code}
            )
            return []
        records = (resp.json() or {}).get("data", [])
        result = []
        for item in records:
            emails = item.get("emails") or []
            result.append(
                {
                    "candidateId": item.get("id", ""),
                    "name": item.get("name", ""),
                    "email": emails[0] if emails else "",
                    "stage": (item.get("stage") or {}).get("text", ""),
                    "tenantId": self.tenant_id,
                }
            )
        self._log_sync("sync_candidates", "success", {"count": len(result)})
        return result

    async def sync_job_descriptions(self) -> list[dict]:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.get(
                f"{self.base_url}/postings",
                headers=self._headers(),
                params={"state": "published"},
            )
        if not resp.is_success:
            self._log_sync("sync_jobs", "failed", {"statusCode": resp.status_code})
            return []
        records = (resp.json() or {}).get("data", [])
        jobs = [
            {
                "jobId": item.get("id", ""),
                "title": item.get("text", ""),
                "department": (item.get("categories") or {}).get("department", ""),
                "location": (item.get("categories") or {}).get("location", ""),
                "description": item.get(
                    "descriptionPlain", item.get("description", "")
                ),
                "tenantId": self.tenant_id,
            }
            for item in records
        ]
        self._log_sync("sync_jobs", "success", {"count": len(jobs)})
        return jobs

    async def export_recruiter_feedback(
        self, interview_id: str, feedback: dict
    ) -> dict:
        candidate_id = feedback.get("candidateId", "")
        if not candidate_id:
            return {"success": False, "error": "candidateId required"}
        note = (
            f"Recruiter feedback for interview {interview_id}\n"
            f"Decision: {feedback.get('humanDecision', '')}\n"
            f"Score: {feedback.get('humanScore', '')}\n"
            f"Comment: {feedback.get('comment', '')}"
        )
        async with httpx.AsyncClient(timeout=20.0) as client:
            resp = await client.post(
                f"{self.base_url}/candidates/{candidate_id}/notes",
                headers=self._headers(),
                json={"value": note},
            )
        self._log_sync(
            "export_feedback",
            "success" if resp.is_success else "failed",
            {"statusCode": resp.status_code},
        )
        return {"success": resp.is_success, "statusCode": resp.status_code}

    def verify_webhook(self, payload: bytes, signature: str) -> bool:
        secret = self.credentials.get("webhook_secret", "")
        if not secret or not signature:
            return False
        expected = hmac.new(secret.encode(), payload, hashlib.sha256).hexdigest()
        return hmac.compare_digest(expected, signature.replace("sha256=", ""))


def _map_report_to_lever_note(report: dict) -> str:
    decision = (report.get("confidenceDecision") or {}).get("label", "REVIEW_REQUIRED")
    tech = report.get("technicalEvaluation") or {}
    hr = report.get("hrEvaluation") or {}
    strengths = (tech.get("strengths") or []) + (hr.get("strengths") or [])
    weaknesses = (tech.get("weaknesses") or []) + (hr.get("weaknesses") or [])
    return (
        "AI Interview Intelligence Report\n"
        f"Interview ID: {report.get('interviewId', '')}\n"
        f"Overall Score: {report.get('overallScore', 'N/A')}\n"
        f"Decision: {decision}\n"
        f"Confidence: {(report.get('confidenceDecision') or {}).get('confidence', 'N/A')}\n"
        f"Strengths: {', '.join(strengths[:5]) or 'No explicit strengths available'}\n"
        f"Weaknesses: {', '.join(weaknesses[:5]) or 'No explicit weaknesses available'}\n"
        "Note: deterministic final report remains source of truth."
    )
