"""Full call-room interview simulation against the REAL LLM.

Drives InterviewEngine through all 5 phases with realistic candidate answers and
prints the candidate <-> Nour transcript, per-turn scoring, and phase switches.

Run:  python -m Backend.voice_engine.scripts.full_callroom_phase_demo
"""
from __future__ import annotations

import os
import sys
import textwrap
import time
from pathlib import Path

# Seconds to wait between turns so we stay under Groq's free-tier 8000 tokens/min
# (TPM) limit. Real interviews pace themselves via speech; this only matters for
# a back-to-back scripted demo. Override with DEMO_TURN_DELAY_SEC=0 to disable.
TURN_DELAY_SEC = float(os.getenv("DEMO_TURN_DELAY_SEC", "13"))

# Longer LLM timeout so gpt-oss-120b doesn't fall back to canned questions.
os.environ.setdefault("AGENT_LLM_TIMEOUT_MS", "30000")

REPO_ROOT = Path(__file__).resolve().parents[3]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from dotenv import load_dotenv  # noqa: E402

load_dotenv(REPO_ROOT / ".env")
load_dotenv(REPO_ROOT / "Backend" / "voice_engine" / "interview_agent" / ".env")

from Backend.voice_engine.interview_agent.interview_engine import (  # noqa: E402
    InterviewEngine,
    PHASE_TARGETS,
)
from Backend.voice_engine.interview_agent.llm_client import build_client_from_env  # noqa: E402

# Phase-appropriate candidate answers. We pick the next unused answer for
# whatever phase the engine reports, so the candidate always stays on-topic.
CANDIDATE_ANSWERS = {
    "introduction": [
        "Hi Nour, thanks. I'm Alex, a software engineer with about four years of "
        "experience building backend and ML services in Python. I applied because this "
        "role combines real product work with applied AI, which is exactly where I want to grow.",
        "What draws me to your company specifically is the recruiting-AI focus — I like "
        "products that automate tedious work fairly, and longer term I want to move toward "
        "an ML platform / tech-lead track.",
    ],
    "experience": [
        "At Acme I led a data pipeline that ingested resumes and job posts. I owned the "
        "Python services and the Postgres schema, and we cut end-to-end processing latency "
        "by about 40 percent by batching embeddings and adding a Redis cache.",
        "One project I'm proud of: a React dashboard plus a Node API for recruiters to "
        "compare candidates. I built the ranking endpoint and the caching layer; it dropped "
        "p95 latency from 1.2s to 300ms and is still in production.",
        "My exact contribution was the backend and the model-serving glue. I designed the "
        "API contract, wrote the FastAPI service, and set up the evaluation harness so we "
        "could measure ranking quality before shipping.",
    ],
    "technical": [
        "For a slow Python endpoint I'd first profile with cProfile or py-spy to find the "
        "real hotspot, check N+1 DB queries, add indexes or batching, and only then reach "
        "for caching or async. I avoid micro-optimizing before measuring.",
        "To scale embeddings I'd batch requests, cache by content hash in Redis, and move "
        "generation to a background worker queue so the request path stays fast. I'd add a "
        "circuit breaker around the model provider too.",
        "For a flaky React component I'd reproduce with a failing test, check effect "
        "dependencies and stale closures, memoize expensive renders, and verify with React "
        "Profiler. Usually it's an unstable dependency in a useEffect.",
        "I'd design the ranking service as a stateless API behind a load balancer, push "
        "heavy scoring to workers, cache results per (job, candidate) key, and add idempotent "
        "retries. I'd watch p95 latency and error rate as the main SLOs.",
    ],
    "behavioral": [
        "Situation: a teammate and I disagreed on whether to rewrite a service. Task: we had "
        "a tight deadline. Action: I proposed a small spike to compare both approaches with "
        "data instead of opinions. Result: the spike showed a targeted refactor was enough, "
        "we shipped on time and kept the relationship healthy.",
        "Under pressure before a release, our pipeline broke at 11pm. I stayed calm, "
        "rolled back the bad migration, added a regression test, and wrote a short postmortem "
        "the next day so it wouldn't happen again.",
    ],
    "closing": [
        "Yes — what does the team's day-to-day look like, and how is success measured in the "
        "first six months?",
        "That's helpful, thank you. No more questions from me — I appreciate your time, Nour.",
    ],
}


def wrap(label: str, text: str, width: int = 96) -> str:
    body = textwrap.fill(text, width=width, subsequent_indent=" " * (len(label)))
    return f"{label}{body}"


def main() -> None:
    try:
        client = build_client_from_env()
    except Exception as exc:  # pragma: no cover - demo helper
        print(f"!! Could not build LLM client ({exc}). Falling back is fine but questions "
              "will be canned.")
        raise

    engine = InterviewEngine(client)
    print("=" * 100)
    print(f"PROVIDER={os.getenv('LLM_PROVIDER')}  MODEL={os.getenv('GROQ_MODEL', 'openai/gpt-oss-120b')}")
    print(f"PHASE TARGETS (questions per phase): {PHASE_TARGETS}")
    print("=" * 100)

    interview_id = "demo-callroom-1"
    r = engine.start(
        interview_id,
        job_title="AI Software Engineer",
        job_skills=["Python", "React", "Node.js", "FastAPI", "Redis", "PostgreSQL"],
        job_description="Build AI-powered recruiting tools: candidate ranking, interview agents.",
        candidate_name="Alex",
        candidate_profile={
            "short_description": "Backend + ML engineer, 4 yrs, Python/React/Node.",
            "skills": ["Python", "React", "Node.js", "FastAPI", "Redis", "PostgreSQL"],
            "experience": [
                {"title": "Software Engineer", "company": "Acme", "duration": "3 yrs",
                 "description": "Resume/job ingestion pipeline, candidate ranking API."},
            ],
        },
        interview_style="friendly",
        phase="intro",
        preferred_language="en",
        seniority="Mid",
    )

    used = {k: 0 for k in CANDIDATE_ANSWERS}
    last_phase = r["current_phase"]
    print(f"\n=== PHASE 1: {last_phase.upper()} ===\n")
    print(wrap("NOUR >> ", r["agent_message"]["text"]))

    phase_num = 1
    for turn in range(1, 25):
        cur = r["current_phase"]
        pool = CANDIDATE_ANSWERS.get(cur, CANDIDATE_ANSWERS["closing"])
        idx = min(used[cur], len(pool) - 1)
        used[cur] += 1
        answer = pool[idx]

        print(wrap("ALEX << ", answer))

        if TURN_DELAY_SEC > 0:
            time.sleep(TURN_DELAY_SEC)
        r = engine.candidate_turn(
            interview_id, text=answer, sentiment={"label": "POSITIVE", "score": 0.7}
        )

        new_phase = r["current_phase"]
        if new_phase != last_phase:
            phase_num += 1
            print(f"\n=== PHASE {phase_num}: {new_phase.upper()}  "
                  f"(phase_advanced={r.get('phase_advanced')}) ===\n")
            last_phase = new_phase

        sc = r["scoring"]
        print(f"        · score={sc['score']}  conf={sc['confidence']}  theta={sc['theta']}  "
              f"difficulty={r['agent_message']['difficulty']}  skill={r['agent_message']['skill_focus']}")
        print(wrap("NOUR >> ", r["agent_message"]["text"]))

        if r["done"]:
            print("\n>>> Interview complete (done=True at closing).")
            break

    print("\n" + "=" * 100)
    print("FINAL REPORT — per-phase breakdown")
    print("=" * 100)
    report = engine.end(interview_id)["report"]
    for row in report["phase_breakdown"]:
        print(f"  {row['phase']:<13} bucket={row['legacy_bucket']:<10} "
              f"answers={row['answers']}  score={row['score']}  avg_diff={row['average_difficulty']}")
    print("\n  phase_history:", report["phase_history"])
    cs = report["category_scores"]
    print(f"\n  legacy category scores (unchanged pipeline):")
    print(f"    overall : score={cs['overall']['score']} answers={cs['overall']['answers']}")
    print(f"    hr      : score={cs['hr']['score']} answers={cs['hr']['answers']}")
    print(f"    technical: score={cs['technical']['score']} answers={cs['technical']['answers']}")
    print(f"\n  hiring_recommendation: {report['hiring_recommendation']['label']} "
          f"({report['hiring_recommendation']['score_pct']}%)")


if __name__ == "__main__":
    main()
