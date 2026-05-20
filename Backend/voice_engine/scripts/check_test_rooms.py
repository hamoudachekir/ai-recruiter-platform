"""STEP 1 — diagnose the data chain.

Queries `jobinterviewrooms` for the test enterprise user and prints the
interviewStyle on each room. Helps confirm the room creation form is
actually persisting the field.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import pymongo
from bson import ObjectId

ENTERPRISE_ID = "69de57e33e5b115fe5cb2671"
MONGO_URI = os.getenv("MONGO_URI", "mongodb://localhost:27017/ai_recruiter")
DB_NAME = "ai_recruiter"

client = pymongo.MongoClient(MONGO_URI, serverSelectionTimeoutMS=5000)
db = client[DB_NAME]

# `createdBy` is an ObjectId in the schema — query both shapes just in case
query = {
    "$or": [
        {"createdBy": ObjectId(ENTERPRISE_ID)},
        {"createdBy": ENTERPRISE_ID},
        {"company":   ObjectId(ENTERPRISE_ID)},
    ]
}

rooms = list(db["jobinterviewrooms"].find(query).limit(20))

print(f"\nFound {len(rooms)} interview room(s) for enterprise {ENTERPRISE_ID}")
print(f"{'-'*70}")

style_counts: dict[str, int] = {}
for r in rooms:
    style = (r.get("settings") or {}).get("interviewStyle") or r.get("interviewStyle") or "MISSING"
    style_counts[style] = style_counts.get(style, 0) + 1
    print({
        "_id":            str(r["_id"]),
        "title":          r.get("title", "(untitled)"),
        "interviewStyle": style,
        "jobId":          str(r.get("job", "MISSING")),
        "slug":           r.get("slug", "MISSING"),
        "status":         r.get("status", "MISSING"),
    })

print(f"\nStyle distribution: {style_counts}")

expected = {"friendly", "strict", "senior", "junior", "fast_screening"}
have     = set(style_counts.keys()) - {"MISSING"}
missing  = expected - have

if missing:
    print(f"\nStyles missing for full test coverage: {sorted(missing)}")
    print("Run scripts/seed_test_rooms.py to create them.")
else:
    print("\nAll 5 styles present — ready for STEP 3.")

client.close()
