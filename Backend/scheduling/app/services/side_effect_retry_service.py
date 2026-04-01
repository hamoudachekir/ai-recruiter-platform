import logging
from datetime import datetime, timedelta
from typing import Any, Dict, Optional

from bson import ObjectId
from pymongo import ReturnDocument

logger = logging.getLogger(__name__)


class SideEffectRetryService:
    """Queue + state manager for retryable calendar/email side effects."""

    def __init__(self, db, max_attempts: int = 5, base_backoff_seconds: int = 60):
        self.collection = db["scheduling_side_effect_retries"]
        self.max_attempts = max(1, int(max_attempts))
        self.base_backoff_seconds = max(5, int(base_backoff_seconds))

    async def ensure_indexes(self) -> None:
        await self.collection.create_index([("status", 1), ("next_run_at", 1)])
        await self.collection.create_index([("interview_schedule_id", 1), ("job_type", 1)])

    async def enqueue(
        self,
        job_type: str,
        interview_schedule_id: str,
        payload: Dict[str, Any],
        error_message: str,
        delay_seconds: Optional[int] = None,
    ) -> str:
        now = datetime.utcnow()
        delay = max(5, int(delay_seconds or self.base_backoff_seconds))

        doc = {
            "job_type": job_type,
            "interview_schedule_id": interview_schedule_id,
            "payload": payload or {},
            "status": "pending",
            "attempts": 0,
            "max_attempts": self.max_attempts,
            "next_run_at": now + timedelta(seconds=delay),
            "last_error": str(error_message or ""),
            "created_at": now,
            "updated_at": now,
            "locked_at": None,
            "completed_at": None,
            "failed_at": None,
        }

        result = await self.collection.insert_one(doc)
        return str(result.inserted_id)

    async def claim_next_due(self) -> Optional[Dict[str, Any]]:
        now = datetime.utcnow()
        return await self.collection.find_one_and_update(
            {
                "status": {"$in": ["pending", "retrying"]},
                "next_run_at": {"$lte": now},
                "$expr": {"$lt": ["$attempts", "$max_attempts"]},
            },
            {
                "$set": {
                    "status": "processing",
                    "locked_at": now,
                    "updated_at": now,
                }
            },
            sort=[("next_run_at", 1), ("created_at", 1)],
            return_document=ReturnDocument.AFTER,
        )

    async def mark_success(self, job_id: str, result: Optional[Dict[str, Any]] = None) -> bool:
        now = datetime.utcnow()
        update_result = await self.collection.update_one(
            {"_id": ObjectId(job_id)},
            {
                "$set": {
                    "status": "completed",
                    "completed_at": now,
                    "updated_at": now,
                    "result": result or {},
                }
            },
        )
        return update_result.modified_count > 0

    async def mark_failure(self, job_id: str, error_message: str) -> bool:
        now = datetime.utcnow()
        job = await self.collection.find_one_and_update(
            {"_id": ObjectId(job_id)},
            {
                "$inc": {"attempts": 1},
                "$set": {
                    "last_error": str(error_message or "Unknown retry error"),
                    "updated_at": now,
                },
            },
            return_document=ReturnDocument.AFTER,
        )

        if not job:
            return False

        attempts = int(job.get("attempts", 0))
        max_attempts = int(job.get("max_attempts", self.max_attempts))

        if attempts >= max_attempts:
            final_result = await self.collection.update_one(
                {"_id": job["_id"]},
                {
                    "$set": {
                        "status": "failed",
                        "failed_at": now,
                        "updated_at": now,
                    }
                },
            )
            return final_result.modified_count > 0

        backoff_seconds = min(3600, self.base_backoff_seconds * (2 ** max(0, attempts - 1)))
        retry_result = await self.collection.update_one(
            {"_id": job["_id"]},
            {
                "$set": {
                    "status": "retrying",
                    "next_run_at": now + timedelta(seconds=backoff_seconds),
                    "updated_at": now,
                }
            },
        )
        return retry_result.modified_count > 0


def create_side_effect_retry_service(db, settings) -> SideEffectRetryService:
    return SideEffectRetryService(
        db=db,
        max_attempts=settings.side_effect_retry_max_attempts,
        base_backoff_seconds=settings.side_effect_retry_backoff_seconds,
    )
