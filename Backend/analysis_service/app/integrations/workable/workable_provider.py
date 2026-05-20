"""Workable ATS provider implementation."""

from __future__ import annotations

import hashlib
import hmac
import logging
from typing import Optional

import httpx

from app.integrations.base_ats import BaseAtsProvider

_LOG = logging.getLogger(__name__)


class WorkableAtsProvider(BaseAtsProvider):
    """Workable ATS integration using bearer-token auth."""

    provider_name = "workable"

    @property
    def base_url(self) -> str:
        subdomain = self.credentials.get("subdomain", "")
        return f"https://{subdomain}.workable.com/spi/v3"

    def _headers(self) -> dict[str, str]:
        token = self.credentials.get("api_key") or self.credentials.get("token") or ""
        return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}

    def _has_credentials(self) -> bool:
        return bool(
            (self.credentials.get("api_key") or self.credentials.get("token"))
            and self.credentials.get("subdomain")
        )

    async def push_interview_report(
        self, report: dict, job_id: str, candidate_id: str
    ) -> dict:
        if not self._has_credentials():
            self._log_sync("push_report", "failed", {"reason": "missing_credentials"})
            return {"success": False, "error": "Missing Workable credentials"}
        payload = {"body": _map_report_to_workable_comment(report)}
        async with httpx.AsyncClient(timeout=20.0) as client:
            resp = await client.post(
                f"{self.base_url}/jobs/{job_id}/candidates/{candidate_id}/comments",
                headers=self._headers(),
                json=payload,
            )
        self._log_sync(
            "push_report",
            "success" if resp.is_success else "failed",
            {"statusCode": resp.status_code},
        )
        return {"success": resp.is_success, "statusCode": resp.status_code}

    async def sync_candidates(self, job_id: Optional[str] = None) -> list[dict]:
        if not self._has_credentials() or not job_id:
            _LOG.warning(
                "[Workable] Missing credentials/job_id for tenant=%s", self.tenant_id
            )
            return []
        results: list[dict] = []
        next_url: str | None = f"{self.base_url}/jobs/{job_id}/candidates"
        params: dict = {}
        async with httpx.AsyncClient(timeout=30.0) as client:
            while next_url:
                resp = await client.get(
                    next_url, headers=self._headers(), params=params
                )
                if not resp.is_success:
                    self._log_sync(
                        "sync_candidates", "failed", {"statusCode": resp.status_code}
                    )
                    return results
                body = resp.json() or {}
                for item in body.get("candidates", body.get("data", [])):
                    results.append(
                        {
                            "candidateId": item.get("id", ""),
                            "name": item.get("name", item.get("fullname", "")),
                            "email": item.get("email", ""),
                            "stage": item.get("stage", ""),
                            "tenantId": self.tenant_id,
                        }
                    )
                paging = body.get("paging") or {}
                next_token = paging.get("next") or body.get("next_page")
                if next_token and not str(next_token).startswith("http"):
                    next_url = f"{self.base_url}/jobs/{job_id}/candidates"
                    params = {"page": next_token}
                else:
                    next_url = next_token
                    params = {}
        self._log_sync("sync_candidates", "success", {"count": len(results)})
        return results

    async def sync_job_descriptions(self) -> list[dict]:
        if not self._has_credentials():
            return []
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.get(
                f"{self.base_url}/jobs",
                headers=self._headers(),
                params={"state": "published"},
            )
        if not resp.is_success:
            self._log_sync("sync_jobs", "failed", {"statusCode": resp.status_code})
            return []
        records = (resp.json() or {}).get("jobs", (resp.json() or {}).get("data", []))
        jobs = [
            {
                "jobId": item.get("shortcode", item.get("id", "")),
                "title": item.get("title", ""),
                "department": item.get("department", ""),
                "location": item.get("location", {}).get(
                    "location_str", item.get("location", "")
                )
                if isinstance(item.get("location"), dict)
                else item.get("location", ""),
                "description": item.get("description", ""),
                "tenantId": self.tenant_id,
            }
            for item in records
        ]
        self._log_sync("sync_jobs", "success", {"count": len(jobs)})
        return jobs

    async def export_recruiter_feedback(
        self, interview_id: str, feedback: dict
    ) -> dict:
        job_id = feedback.get("jobId", "")
        candidate_id = feedback.get("candidateId", "")
        if not job_id or not candidate_id:
            return {"success": False, "error": "jobId and candidateId required"}
        body = (
            f"Recruiter feedback for interview {interview_id}\n"
            f"Decision: {feedback.get('humanDecision', '')}\n"
            f"Score: {feedback.get('humanScore', '')}\n"
            f"Comment: {feedback.get('comment', '')}"
        )
        async with httpx.AsyncClient(timeout=20.0) as client:
            resp = await client.post(
                f"{self.base_url}/jobs/{job_id}/candidates/{candidate_id}/comments",
                headers=self._headers(),
                json={"body": body},
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


def _map_report_to_workable_comment(report: dict) -> str:
    decision = (report.get("confidenceDecision") or {}).get("label", "REVIEW_REQUIRED")
    evidence = report.get("questionEvaluations") or []
    evidence_ids = [
        e.get("questionId", "") for e in evidence[:5] if e.get("questionId")
    ]
    return (
        "AI Interview Intelligence Report\n"
        f"Interview ID: {report.get('interviewId', '')}\n"
        f"Overall Score: {report.get('overallScore', 'N/A')}\n"
        f"Decision: {decision}\n"
        f"Evidence IDs: {', '.join(evidence_ids) or 'N/A'}\n"
        "This synced comment is informational; the platform final report remains authoritative."
    )
