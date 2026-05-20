"""Job match scoring service.

Compares candidate answers and extracted skills against job requirements.
Uses deterministic matching — no invented data.

Score weights:
  40% skill match
  25% answer quality (from questionEvaluations)
  20% technical depth
  15% communication/sentiment
"""

from __future__ import annotations

import logging
import re

_LOG = logging.getLogger(__name__)

_WEIGHT_SKILL_MATCH = 0.40
_WEIGHT_ANSWER_QUALITY = 0.25
_WEIGHT_TECH_DEPTH = 0.20
_WEIGHT_COMM = 0.15


def _normalize_skill(skill: str) -> str:
    return skill.lower().strip()


def _skills_match(
    candidate_skills: list[str],
    required_skills: list[str],
) -> tuple[list[str], list[str]]:
    """Return (matched, missing) skills using fuzzy substring matching."""
    matched: list[str] = []
    missing: list[str] = []
    cand_normalized = [_normalize_skill(s) for s in candidate_skills]

    for req in required_skills:
        req_norm = _normalize_skill(req)
        found = any(req_norm in cand or cand in req_norm for cand in cand_normalized)
        if found:
            matched.append(req)
        else:
            missing.append(req)

    return matched, missing


def _score_responsibility_coverage(responsibility: str, candidate_text: str) -> dict:
    """Check if a job responsibility is covered in candidate answers."""
    if not candidate_text:
        return {
            "responsibility": responsibility,
            "status": "not_covered",
            "evidence": None,
        }

    stop_words = {
        "and",
        "or",
        "the",
        "a",
        "an",
        "with",
        "to",
        "for",
        "of",
        "in",
        "using",
        "by",
        "on",
        "at",
        "is",
        "are",
        "be",
    }
    words = [
        w.lower()
        for w in re.findall(r"\b\w+\b", responsibility)
        if w.lower() not in stop_words and len(w) > 3
    ]

    text_lower = candidate_text.lower()
    matches = sum(1 for w in words if w in text_lower)
    coverage_ratio = matches / max(len(words), 1)

    evidence = None
    if coverage_ratio >= 0.5:
        status = "covered"
        for sentence in re.split(r"[.!?]", candidate_text):
            sentence = sentence.strip()
            if any(w in sentence.lower() for w in words):
                evidence = sentence[:150]
                break
        if not evidence:
            evidence = "Candidate discussed related topics."
    elif coverage_ratio >= 0.25:
        status = "partially_covered"
        evidence = "Candidate partially addressed this area."
    else:
        status = "not_covered"

    return {
        "responsibility": responsibility,
        "status": status,
        "evidence": evidence,
    }


def build_job_match_evaluation(
    job_context: dict,
    detected_skills: list[dict],
    question_evaluations: list[dict],
    full_candidate_text: str = "",
) -> dict:
    """Build job match evaluation.

    Args:
        job_context: From resolve_full_job_context (has .linked, .requiredSkills, etc.)
        detected_skills: From skillsExtractedFromInterview.detectedSkills
        question_evaluations: Per-question evaluation dicts
        full_candidate_text: All candidate answer text concatenated

    Returns:
        jobMatchEvaluation dict
    """
    # ── Job not linked ────────────────────────────────────────────────────────
    if not job_context or not job_context.get("linked"):
        return {
            "score": None,
            "fitLevel": "unknown",
            "confidence": "low",
            "matchedSkills": [],
            "missingOrUnverifiedSkills": [],
            "matchedLanguages": [],
            "missingOrUnverifiedLanguages": [],
            "responsibilityCoverage": [],
            "summary": "Job match cannot be calculated because the interview is not linked to a job.",
            "recruiterFollowUpQuestions": [],
        }

    # ── No candidate data ─────────────────────────────────────────────────────
    if not question_evaluations and not detected_skills and not full_candidate_text:
        required = job_context.get("requiredSkills") or []
        langs = job_context.get("requiredLanguages") or []
        return {
            "score": None,
            "fitLevel": "unknown",
            "confidence": "low",
            "matchedSkills": [],
            "missingOrUnverifiedSkills": required,
            "matchedLanguages": [],
            "missingOrUnverifiedLanguages": langs,
            "responsibilityCoverage": [],
            "summary": "Job match cannot be calculated because no candidate answers or skills were detected.",
            "recruiterFollowUpQuestions": [
                f"Can you describe your experience with {s}?" for s in required[:3]
            ],
        }

    # ── Skill match ───────────────────────────────────────────────────────────
    cand_skill_names = [s.get("skill", "") for s in detected_skills]
    required_skills = job_context.get("requiredSkills") or []
    matched_skills, missing_skills = _skills_match(cand_skill_names, required_skills)
    skill_pct = (
        (len(matched_skills) / max(len(required_skills), 1)) * 100
        if required_skills
        else 50.0
    )

    # ── Languages (recruiter to verify manually) ──────────────────────────────
    required_langs = job_context.get("requiredLanguages") or []
    matched_langs: list[str] = []
    missing_langs: list[str] = list(required_langs)

    # ── Answer quality ────────────────────────────────────────────────────────
    if question_evaluations:
        scores = [
            ev.get("score", 0)
            for ev in question_evaluations
            if ev.get("score") is not None
        ]
        avg_quality = sum(scores) / len(scores) if scores else 0.0
        strong_count = sum(
            1 for ev in question_evaluations if ev.get("answerQuality") == "strong"
        )
        tech_depth = min(
            100.0, (strong_count / max(len(question_evaluations), 1)) * 100 + 20
        )
    else:
        avg_quality = 0.0
        tech_depth = 0.0

    # ── Communication ─────────────────────────────────────────────────────────
    if question_evaluations:
        pos_sentiments = sum(
            1 for ev in question_evaluations if ev.get("sentiment") == "positive"
        )
        comm_score = (pos_sentiments / max(len(question_evaluations), 1)) * 100
    else:
        comm_score = 50.0

    # ── Composite score ───────────────────────────────────────────────────────
    raw = (
        skill_pct * _WEIGHT_SKILL_MATCH
        + avg_quality * _WEIGHT_ANSWER_QUALITY
        + tech_depth * _WEIGHT_TECH_DEPTH
        + comm_score * _WEIGHT_COMM
    )
    score = int(min(95, max(0, round(raw))))

    # ── Fit level ─────────────────────────────────────────────────────────────
    if score >= 75:
        fit_level = "strong"
        confidence = "high" if len(matched_skills) >= 3 else "medium"
    elif score >= 55:
        fit_level = "moderate"
        confidence = "medium"
    elif score >= 35:
        fit_level = "weak"
        confidence = "medium"
    else:
        fit_level = "weak"
        confidence = "low"

    # ── Responsibility coverage ───────────────────────────────────────────────
    responsibilities = job_context.get("responsibilities") or []
    responsibility_coverage = [
        _score_responsibility_coverage(resp, full_candidate_text)
        for resp in responsibilities[:6]
    ]

    # ── Recruiter follow-up questions ─────────────────────────────────────────
    follow_ups: list[str] = []
    for skill in missing_skills[:3]:
        follow_ups.append(f"Can you describe your experience with {skill}?")
    if not question_evaluations:
        follow_ups.append(
            "Please walk us through your most relevant project for this role."
        )
    if fit_level == "weak":
        follow_ups.append(
            "What skills are you currently developing to meet this role's requirements?"
        )

    # ── Summary ───────────────────────────────────────────────────────────────
    job_title = job_context.get("title", "this role")
    if fit_level == "strong":
        summary = (
            f"The candidate demonstrates strong fit for {job_title}. "
            f"{len(matched_skills)} of {len(required_skills)} required skills were detected in answers."
        )
    elif fit_level == "moderate":
        summary = (
            f"The candidate shows moderate fit for {job_title}. "
            f"{len(matched_skills)} required skills detected, {len(missing_skills)} unverified."
        )
    else:
        summary = (
            f"Limited job match evidence for {job_title}. "
            f"Only {len(matched_skills)} of {len(required_skills)} required skills were detected."
        )

    return {
        "score": score,
        "fitLevel": fit_level,
        "confidence": confidence,
        "matchedSkills": matched_skills,
        "missingOrUnverifiedSkills": missing_skills,
        "matchedLanguages": matched_langs,
        "missingOrUnverifiedLanguages": missing_langs,
        "responsibilityCoverage": responsibility_coverage,
        "summary": summary,
        "recruiterFollowUpQuestions": follow_ups,
    }
