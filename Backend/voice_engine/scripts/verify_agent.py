"""Smoke-test the new interview agent modules.

Run from the repo root:
    python Backend/voice_engine/scripts/verify_agent.py

Expected output: all PASS lines followed by a summary.
Exit code 0 = all pass, 1 = any failure.
"""
from __future__ import annotations

import sys
from pathlib import Path

# Allow running as a plain script from repo root without installing the package
sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from Backend.voice_engine.interview_agent.agent_prompt_builder import (
    STYLES,
    RoomContext,
    build_system_prompt,
)
from Backend.voice_engine.interview_agent.irt_engine import (
    compute_stress_level,
    fisher_information,
    select_question,
    update_theta,
)

PASSES = 0
FAILURES = 0
JOB = {
    "title":       "Senior Backend Engineer",
    "skills":      ["Python", "FastAPI", "PostgreSQL", "Redis"],
    "description": "Build scalable backend APIs and microservices. 3+ years required.",
}


def check(label: str, condition: bool) -> None:
    global PASSES, FAILURES
    status = "PASS" if condition else "FAIL"
    print(f"  [{status}] {label}")
    if condition:
        PASSES += 1
    else:
        FAILURES += 1


# -- 1. Prompt generation: 5 styles × 2 session types -------------------------
print("\n-- Prompt generation (10 variants) ----------------------------------")
for style in ["friendly", "strict", "senior", "junior", "fast_screening"]:
    for session_type in ["intro", "technical"]:
        ctx = RoomContext(
            room_id          = "test-room",
            candidate_id     = "c-001",
            candidate_name   = "Ahmed",
            job_title        = JOB["title"],
            job_skills       = JOB["skills"],
            job_description  = JOB["description"],
            session_type     = session_type,
            interview_style  = style,
            theta            = 0.0,
            stress_level     = 0.0,
            turn_index       = 0,
            preferred_language = "en",
        )
        prompt = build_system_prompt(ctx)
        check(
            f"{style}/{session_type}: non-empty string",
            isinstance(prompt, str) and len(prompt) > 50,
        )
        check(
            f"{style}/{session_type}: contains 'Nour'",
            "Nour" in prompt,
        )
        check(
            f"{style}/{session_type}: contains output contract field 'score'",
            '"score"' in prompt,
        )
        check(
            f"{style}/{session_type}: contains output contract field 'next_question'",
            '"next_question"' in prompt,
        )

# -- 2. All 5 STYLES defined ---------------------------------------------------
print("\n-- STYLES completeness ----------------------------------------------")
for style in ["friendly", "strict", "senior", "junior", "fast_screening"]:
    cfg = STYLES.get(style, {})
    required_keys = [
        "tone", "question_style", "scoring", "stress_threshold",
        "difficulty_min", "difficulty_max", "follow_up_depth",
        "target_minutes", "comfort_mild", "comfort_moderate", "comfort_high",
    ]
    for k in required_keys:
        check(f"STYLES[{style}] has '{k}'", k in cfg)

# -- 3. IRT: update_theta ------------------------------------------------------
print("\n-- IRT: update_theta ------------------------------------------------")
check("strong answer raises theta",  update_theta(0.0, 0.8, 0.9) > 0)
check("weak answer lowers theta",    update_theta(0.0, 0.2, 0.2) < 0)
check("clamped at +3.0",             update_theta(3.0, 1.0, 1.0) == 3.0)
check("clamped at -3.0",             update_theta(-3.0, 0.0, 0.0) == -3.0)

# -- 4. Stress estimation ------------------------------------------------------
print("\n-- Stress estimation ------------------------------------------------")
high_stress, _ = compute_stress_level(0.2, "NEGATIVE", 3)
low_stress,  _ = compute_stress_level(0.9, "POSITIVE", 0)
check("high-distress case > 0.5",  high_stress > 0.5)
check("low-distress case < 0.3",   low_stress  < 0.3)
check("result clamped to [0,1]",   0.0 <= high_stress <= 1.0 and 0.0 <= low_stress <= 1.0)

# -- 5. Fisher information -----------------------------------------------------
print("\n-- Fisher information -----------------------------------------------")
fi_on_target = fisher_information(0.0, {"b": 0.0})
fi_far_off   = fisher_information(0.0, {"b": 3.0})
check("fisher_information > 0 when theta ~= b",    fi_on_target > 0)
check("fisher_information lower when far from b",  fi_on_target > fi_far_off)
check("fisher_information handles bad input",      fisher_information(0.0, {}) >= 0)

# -- 6. select_question --------------------------------------------------------
print("\n-- select_question --------------------------------------------------")
hint = select_question(0.0, "friendly", "Backend Developer", set())
check("returns a hint (not None)",            hint is not None)
check("hint has 'id'",                        hint is not None and "id" in hint)
check("hint has 'b'",                         hint is not None and "b" in hint)
check("hint has 'text'",                      hint is not None and "text" in hint)
check("hint text mentions job title",         hint is not None and "Backend Developer" in hint["text"])

# When hint id is already used, should return different one
hint2 = select_question(0.0, "friendly", "Backend Developer", {hint["id"]} if hint else set())
check("second call returns different id",     hint2 is not None and (hint is None or hint2["id"] != hint["id"]))

# All difficulty slots exhausted — returns None gracefully
all_ids = {f"friendly_Backend_Developer_{d}" for d in range(1, 6)}
check("returns None when all ids used",       select_question(0.0, "friendly", "Backend Developer", all_ids) is None)

# -- Summary -------------------------------------------------------------------
print(f"\n{'-'*55}")
print(f"  Results: {PASSES} passed, {FAILURES} failed")
if FAILURES == 0:
    print("  OK All checks passed — agent prompt builder is ready.")
else:
    print("  FAIL Some checks failed — review the output above.")
print(f"{'-'*55}\n")

sys.exit(0 if FAILURES == 0 else 1)
