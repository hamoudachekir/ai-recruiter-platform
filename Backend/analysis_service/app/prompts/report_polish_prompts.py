"""Prompts for the optional LLM polish step in the post-interview pipeline.

Convention follows Backend/voice_engine/interview_agent/prompts.py:
dict-of-strings + builder functions, no jinja.

The polish step rewrites recruiter-report prose for clarity and tone WITHOUT
inventing facts. The whitelist of fields it may touch is enforced at merge
time in `report_polish.polish()` — even a misbehaving model cannot drift the
deterministic numeric scores or structural fields.
"""
from __future__ import annotations

import json


POLISH_OUTPUT_CONTRACT = """
Return STRICT JSON with ONLY these fields (omit any field you do not improve;
do NOT invent any other field):

{
  "transcriptSummary": string,
  "finalRecommendation": string,
  "technicalEvaluation": {
    "strengths": [string, ...],
    "weaknesses": [string, ...]
  }
}

HARD RULES:
- DO NOT include numeric scores, IDs, timestamps, durations, percentages,
  event arrays, vision metrics, audio metrics, or any field not listed above.
- DO NOT invent facts not present in the deterministic report.
- DO NOT change meaning. You may only rephrase.
- No markdown fences. No prose outside the JSON object.
""".strip()


POLISH_SYSTEM = (
    "You are an editor refining recruiter-report prose for clarity, warmth, "
    "and professional tone.\n"
    "You are NOT allowed to invent facts. You may only paraphrase what the "
    "deterministic analyzer already produced. Keep the meaning identical.\n"
    "You MUST respect the project's ethical stance: no emotion, stress, "
    "honesty, personality, race, gender, age, disability, or mental-state "
    "inference. Use objective language only "
    '("integrity risk", "needs review", "visual signals").\n\n'
    + POLISH_OUTPUT_CONTRACT
)


# Subset of deterministic-report fields that are safe to expose to the LLM as
# context. Numeric scores and structured event arrays are intentionally
# omitted from the prompt to discourage the model from echoing/altering them.
_PROMPT_CONTEXT_KEYS = (
    "candidateName",
    "jobTitle",
    "duration",
    "transcriptSummary",
    "finalRecommendation",
)


def build_polish_user_prompt(report: dict) -> str:
    context = {k: report.get(k) for k in _PROMPT_CONTEXT_KEYS}
    technical = report.get("technicalEvaluation") or {}
    context["technicalEvaluation"] = {
        "strengths": technical.get("strengths") or [],
        "weaknesses": technical.get("weaknesses") or [],
    }
    return (
        "DETERMINISTIC_REPORT (authoritative; do not change meaning):\n"
        f"{json.dumps(context, indent=2, ensure_ascii=False)}\n\n"
        "Rewrite the prose fields to be clearer and warmer. Preserve the "
        "factual content exactly. Output JSON per the contract."
    )
