"""Hallucination Firewall — Phase 3.

Validates LLM-generated text output against actual transcript evidence
BEFORE it is written to MongoDB.

LLM IS STRICTLY LIMITED TO:
  ✔  summarization of existing transcript content
  ✔  rewriting for clarity
  ✔  explaining evidence that already exists

LLM CANNOT:
  ✗  invent skills not detected in candidate answers
  ✗  create numeric claims not present in the transcript
  ✗  assert facts not grounded in evidence

APPROACH:
  1. Extract skill/technology mentions from the LLM text.
  2. Cross-check each against the deterministically-detected skills list.
  3. Extract numeric claims (X years, N% improvement, etc.).
  4. Soft-check numerics against the raw transcript text.
  5. Return a structured validation result.

IMPORTANT: This is a SOFT firewall.  Violations are logged and flagged but do
NOT cause pipeline failure — the report is still saved with violation metadata
so recruiters can review flagged content.  The only hard rejection of LLM
numeric scores is handled separately by ``_check_no_llm_scores`` in
``report_graph.py``.
"""

from __future__ import annotations

import logging
import re
from datetime import datetime, timezone

_LOG = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Compiled patterns
# ---------------------------------------------------------------------------

# Skill/technology terms that the LLM might hallucinate
_SKILL_PATTERN = re.compile(
    r"\b("
    r"react|angular|vue|javascript|typescript|python|node\.?js|java(?:script)?|"
    r"c#|golang?|rust|"
    r"mongodb|mysql|postgresql|redis|elasticsearch|"
    r"docker|kubernetes|k8s|aws|azure|gcp|"
    r"machine learning|deep learning|llm|langchain|langgraph|"
    r"fastapi|flask|django|express|spring|"
    r"git(?:hub|lab)?|ci/?cd|devops|agile|scrum"
    r")\b",
    re.IGNORECASE,
)

# Numeric claims that should be grounded in the transcript
# e.g. "5 years", "30%", "increased by 3x", "team of 10"
_NUMERIC_CLAIM_PATTERN = re.compile(
    r"\b(\d+(?:\.\d+)?)\s*"
    r"(years?|months?|%|percent|x|times?|users?|people|team members?|engineers?|"
    r"ms|milliseconds?|seconds?|hours?|days?|weeks?)\b",
    re.IGNORECASE,
)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def validate_llm_output_against_evidence(
    llm_text: str,
    transcript_segments: list[dict],
    detected_skills: list[str],
) -> dict:
    """Validate LLM-generated text against actual transcript evidence.

    Args:
        llm_text:            The polished/summarised text produced by the LLM.
        transcript_segments: Raw STT segments  ``[{text, start, end, …}]``.
        detected_skills:     Skill names already verified deterministically
                             from ``skills_service.extract_skills_from_interview``.

    Returns:
        ``{passed, violations, unsupportedSkillClaims,
           unsupportedNumericClaims, confidence, checkedAt}``
    """
    if not llm_text or not llm_text.strip():
        return _clean_result()
    try:
        return _validate(llm_text, transcript_segments, detected_skills)
    except Exception as exc:  # noqa: BLE001
        _LOG.error("[HallucinationGuard] Validation error: %s", exc)
        # Default to passed on internal error — never block the pipeline
        return {
            "passed": True,
            "violations": [f"guard_internal_error: {exc}"],
            "unsupportedSkillClaims": [],
            "unsupportedNumericClaims": [],
            "confidence": 0.0,
            "checkedAt": _utc_iso(),
        }


# ---------------------------------------------------------------------------
# Internal implementation
# ---------------------------------------------------------------------------


def _validate(
    llm_text: str,
    transcript_segments: list[dict],
    detected_skills: list[str],
) -> dict:
    violations: list[str] = []
    unsupported_skills: list[str] = []
    unsupported_numerics: list[str] = []

    # Build a single transcript string for substring checks
    transcript_text = " ".join(
        seg.get("text", "") for seg in transcript_segments if seg.get("text")
    ).lower()

    detected_norm = {s.lower().strip() for s in (detected_skills or [])}

    # ── 1. Skill claim check ─────────────────────────────────────────────
    for mention in set(m.lower() for m in _SKILL_PATTERN.findall(llm_text)):
        in_detected = any(mention in det or det in mention for det in detected_norm)
        in_transcript = mention in transcript_text
        if not in_detected and not in_transcript:
            unsupported_skills.append(mention)
            violations.append(
                f"unsupported_skill: '{mention}' not found in candidate answers or transcript"
            )

    # ── 2. Numeric claim check ───────────────────────────────────────────
    for num, unit in _NUMERIC_CLAIM_PATTERN.findall(llm_text):
        claim = f"{num} {unit}"
        # Accept if the same number appears near the same unit in transcript
        if not re.search(
            r"\b" + re.escape(num) + r"\s*" + re.escape(unit[:4]),
            transcript_text,
            re.IGNORECASE,
        ):
            unsupported_numerics.append(claim)
            violations.append(f"unsupported_numeric: '{claim}' not found in transcript")

    # ── 3. Guard confidence ──────────────────────────────────────────────
    # Higher confidence when we have enough transcript text to check against
    word_count = len(transcript_text.split()) if transcript_text else 0
    if word_count >= 200:
        guard_conf = 0.90
    elif word_count >= 50:
        guard_conf = 0.70
    elif word_count >= 10:
        guard_conf = 0.50
    else:
        # Very little transcript — cannot validate reliably, but don't block
        guard_conf = 0.20

    passed = len(violations) == 0
    if violations:
        _LOG.warning(
            "[HallucinationGuard] %d violation(s): %s", len(violations), violations[:3]
        )
    return {
        "passed": passed,
        "violations": violations,
        "unsupportedSkillClaims": unsupported_skills,
        "unsupportedNumericClaims": unsupported_numerics,
        "confidence": guard_conf,
        "checkedAt": _utc_iso(),
    }


def _clean_result() -> dict:
    return {
        "passed": True,
        "violations": [],
        "unsupportedSkillClaims": [],
        "unsupportedNumericClaims": [],
        "confidence": 1.0,
        "checkedAt": _utc_iso(),
    }


def _utc_iso() -> str:
    return datetime.now(timezone.utc).isoformat()
