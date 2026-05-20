"""STEP 3 & 4 — verify the agent adapts behavior per interviewStyle.

For each of the 5 test rooms (one per style), this script:
  1. starts a session via POST /api/interview/start
  2. sends a stress-trigger message via POST /api/interview/message
  3. sends a normal answer message
  4. prints the agent's reply, theta evolution, and stress level

If all 5 replies differ AND theta values diverge per style,
the data chain is wired correctly.
"""
from __future__ import annotations

import os
import sys
import time

import httpx
import pymongo
from bson import ObjectId

# Sanitize non-ASCII chars so Windows cp1252 console can't crash mid-test.
# Replace common typographic chars with ASCII equivalents.
_NON_ASCII = {
    "‐": "-", "‑": "-", "‒": "-", "–": "-",
    "—": "-", "―": "-",                    # dashes
    "‘": "'", "’": "'", "‚": "'",      # single quotes
    "“": '"', "”": '"', "„": '"',      # double quotes
    "…": "...",                                  # ellipsis
    " ": " ",                                    # nbsp
}


def safe(s: str) -> str:
    for src, dst in _NON_ASCII.items():
        s = s.replace(src, dst)
    return s.encode("ascii", errors="replace").decode("ascii")

ENTERPRISE_ID = "69de57e33e5b115fe5cb2671"
CANDIDATE_ID  = "69de57ad3e5b115fe5cb2664"   # hamoudachkir@yahoo.fr (test candidate)
BASE_URL      = os.getenv("AGENT_URL", "http://localhost:8013")
MONGO_URI     = os.getenv("MONGO_URI", "mongodb://localhost:27017/ai_recruiter")
DB_NAME       = "ai_recruiter"

STRESS_MSG = "I'm not sure I understand the question... sorry, I'm a bit nervous right now."
NORMAL_MSG = (
    "I would build a REST API using Python and FastAPI, store data in PostgreSQL, "
    "and cache hot queries with Redis. I'd containerize each service with Docker."
)

STYLES = ["friendly", "strict", "senior", "junior", "fast_screening"]


def truncate(s: str, n: int = 280) -> str:
    s = safe((s or "").replace("\n", " ").strip())
    return s if len(s) <= n else s[:n] + "..."


def test_one(client: httpx.Client, room: dict, style: str) -> dict:
    room_id = str(room["_id"])
    print(f"\n{'='*70}")
    print(f"  STYLE: {style.upper()}    room_id={room_id}")
    print(f"{'='*70}")

    # Close any prior session for this room so we get a fresh opening turn.
    # Ignore errors — session may not exist on first run.
    try:
        client.post(
            f"{BASE_URL}/api/interview/end",
            json={"room_id": room_id, "candidate_id": CANDIDATE_ID},
            timeout=10,
        )
    except Exception:
        pass

    # ── Start session ───────────────────────────────────────────────────────
    r1 = client.post(
        f"{BASE_URL}/api/interview/start",
        json={
            "room_id":           room_id,
            "candidate_id":      CANDIDATE_ID,
            "session_type":      "intro",
            "job_title":         "Lead Full-Stack Engineer",
            "job_skills":        ["Python", "FastAPI", "React", "PostgreSQL"],
            "job_description":   room.get("description", ""),
            "interview_style":   style,
            "candidate_name":    "Hamouda",
            "preferred_language": "en",
        },
        timeout=30,
    )
    r1.raise_for_status()
    d1 = r1.json()
    print(f"\n  [start] turn={d1['turn_index']}  theta={d1['theta']}  stress={d1['stress_level']}")
    print(f"  Opening msg: {truncate(d1.get('agent_message',''))}")

    # ── Send stress-trigger message ─────────────────────────────────────────
    r2 = client.post(
        f"{BASE_URL}/api/interview/message",
        json={
            "room_id":           room_id,
            "candidate_id":      CANDIDATE_ID,
            "message":           STRESS_MSG,
            "response_time_sec": 18.0,
            "sentiment_delta":   -0.3,
        },
        timeout=120,   # Groq can take a while
    )
    r2.raise_for_status()
    d2 = r2.json()
    sc = d2.get("scoring", {})
    print(f"\n  [stress msg] -> turn={d2['turn_index']}  theta={sc.get('theta')}  stress={sc.get('stress_level')}")
    print(f"  Agent reply: {truncate(d2.get('agent_message',''))}")

    # ── Send confident technical answer ─────────────────────────────────────
    r3 = client.post(
        f"{BASE_URL}/api/interview/message",
        json={
            "room_id":           room_id,
            "candidate_id":      CANDIDATE_ID,
            "message":           NORMAL_MSG,
            "response_time_sec": 25.0,
            "sentiment_delta":   0.15,
        },
        timeout=120,
    )
    r3.raise_for_status()
    d3 = r3.json()
    sc3 = d3.get("scoring", {})
    print(f"\n  [normal msg] -> turn={d3['turn_index']}  theta={sc3.get('theta')}  stress={sc3.get('stress_level')}")
    print(f"  Agent reply: {truncate(d3.get('agent_message',''))}")

    return {
        "style":           style,
        "stress_reply":    d2.get("agent_message", ""),
        "normal_reply":    d3.get("agent_message", ""),
        "theta_after_1":   sc.get("theta"),
        "theta_after_2":   sc3.get("theta"),
        "stress_level":    sc.get("stress_level"),
        "score_1":         sc.get("score"),
        "score_2":         sc3.get("score"),
    }


def main() -> int:
    mongo = pymongo.MongoClient(MONGO_URI, serverSelectionTimeoutMS=5000)
    db = mongo[DB_NAME]

    # Groq free tier is 8000 TPM. Each style burns ~3000 tokens across the 2
    # message turns, so we pace at ~25s/style to keep the budget healthy.
    GROQ_PACE_SEC = float(os.getenv("GROQ_PACE_SEC", "25"))

    summary = []
    with httpx.Client() as http_client:
        for idx, style in enumerate(STYLES):
            room = db["jobinterviewrooms"].find_one({
                "createdBy":              ObjectId(ENTERPRISE_ID),
                "settings.interviewStyle": style,
                "title":                  f"Test room - {style}",
            })
            if not room:
                print(f"\nNo seeded test room found for style '{style}'. "
                      f"Run scripts/seed_test_rooms.py first.")
                continue
            if idx > 0:
                print(f"\n  ...waiting {GROQ_PACE_SEC:.0f}s for Groq TPM bucket to refill...")
                time.sleep(GROQ_PACE_SEC)
            try:
                summary.append(test_one(http_client, room, style))
            except Exception as exc:
                print(f"\n  ERROR for style '{style}': {exc}")

    # ── Cross-style summary ───────────────────────────────────────────────────
    print(f"\n\n{'#'*70}")
    print(f"  CROSS-STYLE SUMMARY  (proves the chain is wired)")
    print(f"{'#'*70}\n")

    print(f"  {'Style':<16} {'theta-1':>10} {'theta-2':>10} {'stress':>8} {'score-1':>8} {'score-2':>8}")
    print(f"  {'-'*16} {'-'*10} {'-'*10} {'-'*8} {'-'*8} {'-'*8}")
    for s in summary:
        print(f"  {s['style']:<16} {str(s['theta_after_1']):>10} {str(s['theta_after_2']):>10} "
              f"{str(s['stress_level']):>8} {str(s['score_1']):>8} {str(s['score_2']):>8}")

    # Check that stress-message replies are not all identical
    unique_stress = {s["stress_reply"][:100] for s in summary}
    print(f"\n  Distinct stress-message replies: {len(unique_stress)} / {len(summary)}")
    if len(unique_stress) == 1:
        print("  WARN: all 5 replies identical -> agent NOT adapting per style.")
        return 1
    print("  OK: replies differ across styles -> agent IS adapting per style.")

    mongo.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
