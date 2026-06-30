"""Deterministic full-interview simulation against InterviewEngine.

Drives a complete session with a MOCK LLM (no network, no voice/STT — candidate
input is plain text) and asserts the 5-phase flow:

  1. session starts in phase 1 (introduction)
  2. all 5 phases are visited, in order
  3. a transition bridge is generated between each phase
  4. CV context is injected in phase 2, job-offer context in phase 3
  5. the session ends (done) after phase 5 (closing)

The phase of every turn is printed so the flow can be eyeballed.

Run:  python -m Backend.voice_engine.scripts.test_phase_flow_simulation
"""
from __future__ import annotations

import re
import sys
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[3]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from Backend.voice_engine.interview_agent.interview_engine import (  # noqa: E402
    InterviewEngine,
    PHASE_SEQUENCE,
)
from Backend.voice_engine.interview_agent.llm_client import LLMClient  # noqa: E402

# Sentinels embedded in the CV / job offer so we can prove they reach the prompt.
CV_SENTINEL = "CVDESC_SENTINEL_7777"
CV_COMPANY_SENTINEL = "AcmeCorp_SENTINEL"
JOB_SENTINEL = "JOBCTX_SENTINEL_4242"


class MockInterviewLLM(LLMClient):
    """Records every prompt it receives and emits a visible bridge when the
    engine asks for a phase transition. Phase advancement itself is driven by
    the engine's per-phase question counts, so the flow is fully deterministic.
    """

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    def complete_json(self, system, messages, temperature=0.6, max_tokens=800):
        user_prompt = messages[-1]["content"]
        phase_match = re.search(r"INTERVIEW_PHASE:\s*(\w+)", user_prompt)
        phase = phase_match.group(1) if phase_match else "?"
        has_transition = "PHASE_TRANSITION:" in user_prompt
        n = len(self.calls)
        self.calls.append({"phase": phase, "has_transition": has_transition, "prompt": user_prompt})

        # Unique wording per call so the duplicate-question guard never fires.
        base = (
            f"Question {n} for the {phase} stage: please walk me through one "
            f"distinct example numbered {n} with concrete detail and an outcome."
        )
        if has_transition:
            base = f"Bridge[{phase}]: thank you, let's move on to the {phase} part. " + base
        return {
            "score": 0.7,
            "confidence": 0.7,
            "reasoning": "mock evaluation",
            "next_question": base,
            "difficulty": 2,
            "skill_focus": "roleassessment",  # avoids intro-project intercept
            "done": False,
            "phase_objective_met": False,
        }


def main() -> int:
    llm = MockInterviewLLM()
    engine = InterviewEngine(llm)
    interview_id = "phase-flow-sim"

    start = engine.start(
        interview_id,
        job_title="AI Software Engineer",
        job_skills=["Python", "React", "Node.js"],
        job_description="Build AI recruiting tools.",
        candidate_name="Alex",
        candidate_profile={
            "short_description": f"{CV_SENTINEL} backend and ML engineer",
            "skills": ["pipelines", "ranking", "evaluation"],
            "experience": [
                {"title": "Engineer", "company": CV_COMPANY_SENTINEL,
                 "duration": "3y", "description": "Built a ranking pipeline."},
            ],
        },
        interview_style="friendly",
        phase="intro",
        preferred_language="en",
        job_context=f"{JOB_SENTINEL} Build a ranking microservice; responsibilities include API design.",
        seniority="Mid",
    )

    # Per-turn record: (turn_index, current_phase, phase_advanced, llm_call_idx_or_None, agent_text)
    timeline: list[tuple[int, str, bool, int | None, str]] = []
    timeline.append((start["turn_index"], start["current_phase"], False, None, start["agent_message"]["text"]))

    r = start
    calls_seen = 0
    for _ in range(30):
        prev_calls = len(llm.calls)
        answer = (
            f"Turn answer: I led a concrete initiative, owned delivery end to end, "
            f"made key design decisions, and we measured a clear improvement; example #{r['turn_index']}."
        )
        r = engine.candidate_turn(interview_id, text=answer, sentiment={"label": "POSITIVE", "score": 0.7})
        call_idx = (len(llm.calls) - 1) if len(llm.calls) > prev_calls else None
        timeline.append((r["turn_index"], r["current_phase"], bool(r.get("phase_advanced")), call_idx,
                         r["agent_message"]["text"]))
        if r["done"]:
            break

    # ---- Print the flow for eyeballing -------------------------------------
    print("=" * 96)
    print(f"{'turn':>4}  {'phase':<13} {'advanced':<9} {'bridge_in_prompt':<16} agent_message")
    print("-" * 96)
    for turn_idx, phase, advanced, call_idx, text in timeline:
        bridge = ""
        if call_idx is not None:
            bridge = "YES" if llm.calls[call_idx]["has_transition"] else "no"
        snippet = (text[:60] + "…") if len(text) > 60 else text
        print(f"{turn_idx:>4}  {phase:<13} {str(advanced):<9} {bridge:<16} {snippet}")
    print("=" * 96)

    # ---- Assertions ---------------------------------------------------------
    # (1) starts in phase 1
    assert start["current_phase"] == "introduction", \
        f"expected to start in 'introduction', got {start['current_phase']!r}"

    # (2) all 5 phases visited, in order
    ordered_phases: list[str] = []
    for _, phase, *_ in timeline:
        if not ordered_phases or ordered_phases[-1] != phase:
            ordered_phases.append(phase)
    assert ordered_phases == PHASE_SEQUENCE, \
        f"phase order mismatch:\n  got      {ordered_phases}\n  expected {PHASE_SEQUENCE}"

    # (3) a transition bridge is generated between each phase (4 boundaries)
    transitions = [(phase, call_idx) for (_, phase, advanced, call_idx, _) in timeline if advanced]
    transitioned_phases = [p for (p, _) in transitions]
    assert transitioned_phases == PHASE_SEQUENCE[1:], \
        f"expected transitions into {PHASE_SEQUENCE[1:]}, got {transitioned_phases}"
    for phase, call_idx in transitions:
        assert call_idx is not None, f"transition into {phase} did not reach the LLM (no bridge prompt)"
        call = llm.calls[call_idx]
        assert call["has_transition"], f"no PHASE_TRANSITION bridge injected entering {phase}"
        assert call["phase"] == phase, f"bridge prompt phase {call['phase']!r} != {phase!r}"

    # (4) CV context in phase 2, job-offer context in phase 3
    phase2_prompts = [c["prompt"] for c in llm.calls if c["phase"] == "experience"]
    phase3_prompts = [c["prompt"] for c in llm.calls if c["phase"] == "technical"]
    assert phase2_prompts, "no LLM prompt captured for the experience phase"
    assert phase3_prompts, "no LLM prompt captured for the technical phase"
    assert any(CV_SENTINEL in p and "CONTEXT_FOCUS" in p and "CANDIDATE_PROFILE" in p for p in phase2_prompts), \
        "phase 2 (experience) prompt missing CV context / CANDIDATE_PROFILE focus"
    assert any(JOB_SENTINEL in p and "CONTEXT_FOCUS" in p and "JOB_SKILLS" in p for p in phase3_prompts), \
        "phase 3 (technical) prompt missing job-offer context / JOB_SKILLS focus"

    # (5) session ends after phase 5
    last_turn = timeline[-1]
    assert last_turn[1] == "closing", f"final turn not in closing phase: {last_turn[1]!r}"
    assert r["done"] is True, "session did not report done=True after the closing phase"
    snapshot = engine.end(interview_id)
    assert snapshot["ended"] is True, "engine.end did not mark the session ended"
    history_phases = [h["phase"] for h in snapshot["report"]["phase_history"]]
    assert history_phases == PHASE_SEQUENCE, \
        f"phase_history mismatch: {history_phases} != {PHASE_SEQUENCE}"

    print("\nPASS — all 5 requirements satisfied:")
    print("  (1) started in phase 1 (introduction)")
    print(f"  (2) visited all phases in order: {' → '.join(ordered_phases)}")
    print(f"  (3) transition bridge injected entering: {', '.join(transitioned_phases)}")
    print("  (4) CV context present in phase 2; job-offer context present in phase 3")
    print("  (5) session ended (done) after closing; phase_history complete")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
