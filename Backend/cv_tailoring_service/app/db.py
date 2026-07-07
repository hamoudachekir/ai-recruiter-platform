from functools import lru_cache
from bson import ObjectId
from bson.errors import InvalidId
from pymongo import MongoClient
from app.config import get_settings


@lru_cache
def _client() -> MongoClient:
    return MongoClient(get_settings().mongo_uri)


def _jobs():
    return _client()[get_settings().mongo_db]["jobs"]


def get_job(job_id: str):
    try:
        oid = ObjectId(job_id)
    except (InvalidId, TypeError):
        return None
    return _jobs().find_one({"_id": oid})


def job_to_text(job: dict) -> str:
    parts = [
        job.get("title", ""),
        job.get("description", ""),
        job.get("companyName", ""),
        " ".join(job.get("skills", []) or []),
        " ".join(job.get("languages", []) or []),
    ]
    return "\n".join(p for p in parts if p)
