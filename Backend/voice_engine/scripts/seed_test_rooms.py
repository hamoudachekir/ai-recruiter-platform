"""STEP 2 — seed test rooms covering all 5 interview styles.

Inserts (or updates) one jobinterviewroom per style for the test enterprise
user, all pointing at the first job that user owns. Idempotent: re-running
upserts by title rather than creating duplicates.
"""
from __future__ import annotations

import base64
import os
import secrets
from datetime import datetime

import pymongo
from bson import ObjectId

ENTERPRISE_ID = "69de57e33e5b115fe5cb2671"
MONGO_URI = os.getenv("MONGO_URI", "mongodb://localhost:27017/ai_recruiter")
DB_NAME = "ai_recruiter"

STYLES = ["friendly", "strict", "senior", "junior", "fast_screening"]


def make_slug() -> str:
    return base64.urlsafe_b64encode(secrets.token_bytes(13)).decode("ascii").rstrip("=")[:18]


def main() -> None:
    client = pymongo.MongoClient(MONGO_URI, serverSelectionTimeoutMS=5000)
    db = client[DB_NAME]
    enterprise_oid = ObjectId(ENTERPRISE_ID)

    # Find the first job owned by this enterprise (field is `entrepriseId`, see job.js)
    job = db["jobs"].find_one({"entrepriseId": enterprise_oid})
    if job is None:
        # Try other common field names just in case
        job = db["jobs"].find_one({"$or": [
            {"postedBy": enterprise_oid},
            {"enterprise": enterprise_oid},
            {"company": enterprise_oid},
        ]})

    if job is None:
        print("No job found for this enterprise. Creating a stub job for test purposes.")
        job_doc = {
            "title":        "Backend Engineer (test)",
            "description":  "Test job for style adaptation verification. "
                            "Build scalable backend APIs using Python and FastAPI.",
            "location":     "Tunis",
            "salary":       0,
            "languages":    ["English", "French"],
            "skills":       ["Python", "FastAPI", "PostgreSQL", "Redis"],
            "createdAt":    datetime.utcnow(),
            "entrepriseId": enterprise_oid,
            "status":       "OPEN",
        }
        result = db["jobs"].insert_one(job_doc)
        job = {**job_doc, "_id": result.inserted_id}
        print(f"  Created job {result.inserted_id}")

    job_id = job["_id"]
    print(f"Using job: {job.get('title', '(untitled)')} ({job_id})")

    for style in STYLES:
        title = f"Test room - {style}"

        existing = db["jobinterviewrooms"].find_one({
            "createdBy": enterprise_oid,
            "title":     title,
        })

        if existing:
            # Make sure style is up-to-date but don't change other fields
            db["jobinterviewrooms"].update_one(
                {"_id": existing["_id"]},
                {"$set": {"settings.interviewStyle": style, "status": "open"}},
            )
            print(f"  [UPDATED] {style:14s} -> _id={existing['_id']}")
            continue

        doc = {
            "job":         job_id,
            "company":     enterprise_oid,
            "createdBy":   enterprise_oid,
            "slug":        make_slug(),
            "title":       title,
            "description": f"Test room for verifying {style} agent behavior",
            "status":      "open",
            "settings": {
                "interviewStyle":          style,
                "maxCandidates":           0,
                "requireFaceVerification": False,
                "preferredLanguage":       "en",
            },
            "stats": {
                "totalSessions":      0,
                "completedSessions":  0,
                "inProgressSessions": 0,
            },
            "createdAt":   datetime.utcnow(),
            "updatedAt":   datetime.utcnow(),
        }
        result = db["jobinterviewrooms"].insert_one(doc)
        print(f"  [CREATED] {style:14s} -> _id={result.inserted_id}")

    print("\nDone. Re-run scripts/check_test_rooms.py to confirm.")
    client.close()


if __name__ == "__main__":
    main()
