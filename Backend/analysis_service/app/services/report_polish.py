"""Optional LLM polish step for the post-interview report.

The deterministic report from `report_service.build_final_report()` is the
source of truth. This step rewrites a STRICT WHITELIST of prose fields for
clarity and tone, then merges the result with type-checks and a re-pin of
all deterministic numeric/structural fields so a misbehaving model cannot
corrupt scores, risk levels, event counts, or decisions.

Polish failures must NEVER fail the surrounding job. On any error the
deterministic report is returned unchanged with a `polish_status` other
than "completed".

Return value:  (merged_report, polish_status, llm_used)
  polish_status : "completed" | "failed" | "timeout" | "skipped"
  llm_used      : True only when the LLM call succeeded and the result was merged
"""

from __future__ import annotations

import copy
import logging
import os
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FuturesTimeoutError
from typing import Any, Literal

from app.llm.client import GeminiClient, LLMError, build_client_from_env
from app.prompts.report_polish_prompts import POLISH_SYSTEM, build_polish_user_prompt
from app.schemas.report_schema import validate_final_report

PolishStatus = Literal["skipped", "completed", "failed", "timeout"]

_LOG = logging.getLogger(__name__)

_POLISH_TIMEOUT_SECONDS = float(os.getenv("REPORT_POLISH_TIMEOUT_SEC", "25.0"))

# ---------------------------------------------------------------------------
# Whitelist of fields that LLM polish is allowed to modify.
# ALL other fields are considered deterministic and will be re-pinned.
# ---------------------------------------------------------------------------
_ALLOWED_POLISH_PATHS = {
    # Top-level text fields
    "transcriptSummary",
    "recommendationText",
    "summary",
    "recruiterNotes",
    # Technical evaluation prose
    "technicalEvaluation.strengths",
    "technicalEvaluation.weaknesses",
    "technicalEvaluation.technicalInsights",
    "technicalEvaluation.summary",
    # HR evaluation prose
    "hrEvaluation.strengths",
    "hrEvaluation.weaknesses",
    "hrEvaluation.hrInsights",
    "hrEvaluation.summary",
    "hrEvaluation.communicationAnalysis.summary",
    # Final recommendation prose
    "finalRecommendation.summary",
    "finalRecommendation.nextStep",
    "finalRecommendation.recruiterNotes",
    # Vision integrity report summary only
    "visionIntegrityReport.summary",
    # AI interviewer notes
    "aiInterviewerNotes.summary",
    "aiInterviewerNotes.strengths",
    "aiInterviewerNotes.weaknesses",
    "aiInterviewerNotes.recommendedFollowUpQuestions",
    # Question evaluations feedback
    "questionEvaluations",
}

# ---------------------------------------------------------------------------
# Forbidden fields — these must NEVER be touched by the LLM.
# Re-pinned defensively after every merge.
# ---------------------------------------------------------------------------
_FORBIDDEN_SCALAR_KEYS = {
    "humanReviewRequired",
    "ethicsNote",
    "recruiterDecision",
    "reportQuality",
    "recruiterDecisionSummary",
    "evidence",
    "candidateInfo",
    "identity",
    "interviewId",
    "candidateName",
    "jobTitle",
    "duration",
    "durationSeconds",
    "generatedAt",
    "updatedAt",
    "createdAt",
    "audioAnalysis",
    "integrityAlerts",
    "visionMonitoring",
    "polish",  # metadata added by this module — LLM must never overwrite it
    # Numeric scores - strictly protected
    "overallScore",
    "technicalScore",
    "hrScore",
    "integrityScore",
    "cameraScore",
    "audioScore",
    "quizScore",
    "cvJobMatchScore",
    # New enhanced fields — all protected
    "interviewQna",
    "skillsExtractedFromInterview",
    "jobContext",
    "jobMatchEvaluation",
    "answerSentimentSummary",
    "enhancedRecommendation",
}

# Nested keys that are strictly numeric/protected
_PROTECTED_NUMERIC_PATHS = {
    "technicalEvaluation.score",
    "hrEvaluation.score",
    "visionMonitoring.faceVisiblePercent",
    "visionMonitoring.faceVisibilityRate",
    "visionMonitoring.absenceEvents",
    "visionMonitoring.lightingIssues",
    "visionMonitoring.positionIssues",
    "visionMonitoring.totalChecks",
    "visionMonitoring.faceDetectedChecks",
    "visionMonitoring.tabSwitchEvents",
    "visionMonitoring.fullscreenExitEvents",
    "audioAnalysis.transcriptionAvailable",
    "audioAnalysis.longSilenceEvents",
    "audioAnalysis.silenceEvents",
    "audioAnalysis.longSilenceSeconds",
    "integrity.totalAlerts",
    "integrity.highSeverityCount",
    "integrity.mediumSeverityCount",
    "integrity.lowSeverityCount",
    "finalRecommendation.status",
    "finalRecommendation.overallScore",
    "finalRecommendation.score",
    "finalRecommendation.riskLevel",
    "reportQuality.confidence",
    "reportQuality.isReliableForDecision",
}


def is_allowed_polish_path(path: str) -> bool:
    """Check if a field path is allowed to be modified by LLM polish.

    Args:
        path: Dot-notation path to the field (e.g., "technicalEvaluation.score").

    Returns:
        True if the path is in the allowed whitelist.
    """
    # Direct match
    if path in _ALLOWED_POLISH_PATHS:
        return True
    # Check if it's a questionEvaluations array element
    if path.startswith("questionEvaluations.") or path.startswith(
        "questionEvaluations["
    ):
        return "questionEvaluations" in _ALLOWED_POLISH_PATHS
    return False


def _is_protected_numeric_path(path: str) -> bool:
    """Check if a field path contains a protected numeric value.

    Args:
        path: Dot-notation path to the field.

    Returns:
        True if the path should be protected from modification.
    """
    return path in _PROTECTED_NUMERIC_PATHS


def _get_nested_value(data: dict, path: str) -> Any:
    """Get a value from a nested dictionary using dot notation.

    Args:
        data: The dictionary to search.
        path: Dot-notation path (e.g., "a.b.c").

    Returns:
        The value at the path, or None if not found.
    """
    keys = path.split(".")
    current = data
    for key in keys:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
        if current is None:
            return None
    return current


def _set_nested_value(data: dict, path: str, value: Any) -> None:
    """Set a value in a nested dictionary using dot notation.

    Args:
        data: The dictionary to modify.
        path: Dot-notation path (e.g., "a.b.c").
        value: The value to set.
    """
    keys = path.split(".")
    current = data
    for key in keys[:-1]:
        if key not in current or not isinstance(current[key], dict):
            current[key] = {}
        current = current[key]
    current[keys[-1]] = value


def _build_polish_client_from_env() -> tuple["LLMClient", str, str]:  # type: ignore[name-defined]
    """Return (client, provider_label, model_label).

    Priority for provider selection:
      1. REPORT_POLISH_PROVIDER  (polish-specific override)
      2. LLM_PROVIDER            (shared interview-agent setting)
      3. "echo"                  (offline stub — no API key needed)
    """
    provider = (os.getenv("REPORT_POLISH_PROVIDER") or "").strip().lower() or (
        os.getenv("LLM_PROVIDER") or "echo"
    ).strip().lower()

    if provider == "gemini":
        key = (os.getenv("GEMINI_API_KEY") or "").strip()
        if not key:
            raise LLMError(
                "GEMINI_API_KEY is not set — set it in .env or disable polish"
            )
        model = (os.getenv("REPORT_POLISH_MODEL") or "gemini-2.5-flash-lite").strip()
        _LOG.info("polish provider=gemini model=%s", model)
        return GeminiClient(api_key=key, model=model), "gemini", model

    # All other providers (nvidia, anthropic, openai, ollama, echo) use the
    # shared factory which reads LLM_PROVIDER.
    client = build_client_from_env()
    model_env_map = {
        "nvidia": "NVIDIA_MODEL",
        "anthropic": "ANTHROPIC_MODEL",
        "openai": "OPENAI_MODEL",
        "ollama": "OLLAMA_MODEL",
    }
    model = os.getenv(model_env_map.get(provider, ""), provider)
    _LOG.info("polish provider=%s model=%s", provider, model)
    return client, provider, model


def _is_retryable_error(error_str: str) -> bool:
    """Check if an error is retryable (e.g., 503 Service Unavailable)."""
    retryable_patterns = [
        "503",
        "service unavailable",
        "rate limit",
        "too many requests",
    ]
    error_lower = str(error_str).lower()
    return any(pattern in error_lower for pattern in retryable_patterns)


def polish(
    report: dict,
    *,
    timeout_s: float = _POLISH_TIMEOUT_SECONDS,
) -> tuple[dict, PolishStatus, bool]:
    """Apply the optional LLM polish to a deterministic report.

    Returns ``(merged_report, status, llm_used)``.
    The merged report is always at least as safe as the input:
    - forbidden fields are never overwritten
    - deterministic scores are re-pinned after every merge
    - on any failure the original report is returned with polish.success=false

    Improved error handling:
    - Retries once with exponential backoff for 503/rate-limit errors
    - Provides user-friendly error messages in main UI
    - Stores full debug errors in collapsed system metadata
    """
    if not isinstance(report, dict):
        return report, "skipped", False

    provider_label = "unknown"
    model_label = "unknown"

    def _make_polish_metadata(
        success: bool,
        user_message: str,
        debug_error: str = "",
        fallback_used: bool = False,
    ) -> dict:
        return {
            "enabled": True,
            "provider": provider_label,
            "model": model_label,
            "success": success,
            "fallbackUsed": fallback_used,
            "userFriendlyMessage": user_message,
            "debugError": debug_error,
            "error": debug_error if not success else None,  # Legacy field
        }

    def _failed(
        reason: str,
        status: PolishStatus,
        user_message: str = "",
    ) -> tuple[dict, PolishStatus, bool]:
        out = copy.deepcopy(report)
        # Default user-friendly message if not provided
        if not user_message:
            if "timeout" in status:
                user_message = "LLM polish timed out. Deterministic report shown."
            else:
                user_message = "LLM polish unavailable. Deterministic report shown."
        out["polish"] = _make_polish_metadata(
            success=False,
            user_message=user_message,
            debug_error=reason,
        )
        return out, status, False

    try:
        client, provider_label, model_label = _build_polish_client_from_env()
    except LLMError as exc:
        _LOG.warning("polish skipped — LLM client unavailable: %s", exc)
        return _failed(
            f"LLM client unavailable: {exc}",
            "failed",
            "LLM client not configured. Deterministic report shown.",
        )

    user_prompt = build_polish_user_prompt(report)

    def _call() -> dict:
        return client.complete_json(
            POLISH_SYSTEM,
            [{"role": "user", "content": user_prompt}],
            temperature=0.2,
            max_tokens=600,
        )

    # Attempt with retry logic for transient errors
    max_attempts = 2
    last_error = ""

    for attempt in range(1, max_attempts + 1):
        try:
            _LOG.info("polish attempt %d/%d", attempt, max_attempts)
            with ThreadPoolExecutor(max_workers=1) as pool:
                future = pool.submit(_call)
                llm_out = future.result(timeout=timeout_s)
            # Success - break out of retry loop
            break
        except FuturesTimeoutError:
            _LOG.warning(
                "polish timed out after %.1fs on attempt %d", timeout_s, attempt
            )
            if attempt == max_attempts:
                return _failed(
                    f"LLM polish timed out after {timeout_s}s",
                    "timeout",
                    "LLM polish timed out. Deterministic report shown.",
                )
            # Retry after short delay
            import time

            time.sleep(2**attempt)  # Exponential backoff
        except LLMError as exc:
            error_str = str(exc)
            _LOG.warning("polish LLM error on attempt %d: %s", attempt, exc)
            last_error = error_str

            # Check if retryable
            if attempt < max_attempts and _is_retryable_error(error_str):
                _LOG.info("polish retrying after retryable error...")
                import time

                time.sleep(2**attempt)  # Exponential backoff
                continue

            # Not retryable or last attempt
            user_message = "LLM polish unavailable due to provider error. Deterministic report shown."
            if "503" in error_str:
                user_message = "LLM polish unavailable due to temporary provider demand. Deterministic report shown."
            return _failed(f"LLM error: {exc}", "failed", user_message)
        except Exception as exc:  # noqa: BLE001
            _LOG.warning("polish unexpected error on attempt %d: %s", attempt, exc)
            if attempt == max_attempts:
                return _failed(
                    f"Unexpected error: {exc}",
                    "failed",
                    "Unexpected error during polish. Deterministic report shown.",
                )
            import time

            time.sleep(2**attempt)

    if not isinstance(llm_out, dict):
        _LOG.warning("polish: LLM returned non-dict — returning deterministic report")
        return _failed("LLM returned non-dict response", "failed")

    merged = _whitelist_merge(report, llm_out)

    # Validate final report against schema before returning
    try:
        validated = validate_final_report(merged)
        validated["polish"] = _make_polish_metadata(
            success=True,
            user_message="Report polished successfully.",
            debug_error="",
            fallback_used=False,
        )
        _LOG.info("polish completed successfully with schema validation")
        return validated, "completed", True
    except ValueError as e:
        _LOG.error(
            "polish: Schema validation failed — returning deterministic report: %s", e
        )
        # Return deterministic report with polish failure metadata
        safe_out = copy.deepcopy(report)
        safe_out["polish"] = _make_polish_metadata(
            success=False,
            user_message="Report polish failed validation. Deterministic report shown.",
            debug_error=f"Schema validation failed: {e}",
        )
        return safe_out, "failed", False


# ---------------------------------------------------------------------------
# Whitelist merge
# ---------------------------------------------------------------------------


def _safe_str(value: object) -> str | None:
    """Return stripped string if non-empty, else None."""
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def _safe_str_list(value: object) -> list[str] | None:
    """Return list of non-empty stripped strings if valid, else None."""
    if (
        isinstance(value, list)
        and value
        and all(isinstance(x, str) and x.strip() for x in value)
    ):
        return [s.strip() for s in value]
    return None


def _has_usable_transcript(report: dict) -> bool:
    if "transcript" not in report and "transcriptionAvailable" not in report:
        return True
    transcript = report.get("transcript") or {}
    full_text = str(transcript.get("fullText") or transcript.get("text") or "")
    segments = transcript.get("segments") or []
    return bool(
        full_text.strip() and (len(full_text.strip()) > 30 or len(segments) > 0)
    )


def _whitelist_merge(report: dict, llm_out: dict) -> dict:
    """Merge ONLY whitelisted prose fields from ``llm_out`` into ``report``.

    Safety rules
    ────────────
    1. Only the explicit whitelist below is ever merged.
    2. Nested prose keys are only merged if their PARENT already exists in
       the deterministic report — the LLM cannot inject new top-level keys.
    3. All forbidden scalar fields are re-pinned from the original after merge.
    4. All score / risk-level / event-count fields are re-pinned explicitly.

    Whitelisted fields (per spec)
    ─────────────────────────────
    • transcriptSummary                        (top-level string)
    • technicalEvaluation.strengths            (list[str])
    • technicalEvaluation.weaknesses           (list[str])
    • finalRecommendation                      (string — only if schema stores it as str)
    • finalRecommendation.summary              (string — if schema uses object form)
    • finalRecommendation.nextStep             (string — if schema uses object form)
    • questionEvaluations[].feedback           (string per element — if array exists)
    • communicationAnalysis.summary            (string — if key exists)
    • visionIntegrityReport.summary            (string — if key exists)
    • aiInterviewerNotes.summary               (string — if key exists)
    • aiInterviewerNotes.strengths             (list[str] — if key exists)
    • aiInterviewerNotes.weaknesses            (list[str] — if key exists)
    • aiInterviewerNotes.recommendedFollowUpQuestions  (list[str] — if key exists)
    """
    merged = copy.deepcopy(report)
    has_usable_transcript = _has_usable_transcript(report)

    # ── transcriptSummary ────────────────────────────────────────────────────
    val = _safe_str(llm_out.get("transcriptSummary"))
    if val:
        merged["transcriptSummary"] = val

    # ── technicalEvaluation prose (score is re-pinned below) ─────────────────
    llm_tech = llm_out.get("technicalEvaluation")
    if isinstance(llm_tech, dict) and "technicalEvaluation" in report:
        merged_tech = merged.setdefault("technicalEvaluation", {})
        strengths = _safe_str_list(llm_tech.get("strengths"))
        if strengths and has_usable_transcript:
            merged_tech["strengths"] = strengths
        weaknesses = _safe_str_list(llm_tech.get("weaknesses"))
        if weaknesses and has_usable_transcript:
            merged_tech["weaknesses"] = weaknesses
        summary = _safe_str(llm_tech.get("summary"))
        if summary:
            merged_tech["summary"] = summary
        tech_insights = _safe_str(llm_tech.get("technicalInsights"))
        if tech_insights:
            merged_tech["technicalInsights"] = tech_insights

    # ── hrEvaluation prose (score is re-pinned below) ──────────────────────
    llm_hr = llm_out.get("hrEvaluation")
    if isinstance(llm_hr, dict) and "hrEvaluation" in report:
        merged_hr = merged.setdefault("hrEvaluation", {})
        strengths = _safe_str_list(llm_hr.get("strengths"))
        if (
            strengths
            and has_usable_transcript
            and report.get("hrEvaluation", {}).get("score") is not None
        ):
            merged_hr["strengths"] = strengths
        weaknesses = _safe_str_list(llm_hr.get("weaknesses"))
        if (
            weaknesses
            and has_usable_transcript
            and report.get("hrEvaluation", {}).get("score") is not None
        ):
            merged_hr["weaknesses"] = weaknesses
        summary = _safe_str(llm_hr.get("summary"))
        if summary:
            merged_hr["summary"] = summary
        hr_insights = _safe_str(llm_hr.get("hrInsights"))
        if hr_insights:
            merged_hr["hrInsights"] = hr_insights
        # communicationAnalysis.summary nested under hrEvaluation
        if "communicationAnalysis" in llm_hr:
            comm = llm_hr["communicationAnalysis"]
            if isinstance(comm, dict):
                comm_summary = _safe_str(comm.get("summary"))
                if comm_summary:
                    merged_hr.setdefault("communicationAnalysis", {})["summary"] = (
                        comm_summary
                    )

    # ── finalRecommendation — handle both string schema and object schema ─────
    existing_rec = report.get("finalRecommendation")
    llm_rec = llm_out.get("finalRecommendation")

    if isinstance(existing_rec, dict):
        # Schema stores finalRecommendation as an object — allow prose subkeys.
        if isinstance(llm_rec, dict):
            merged_rec = merged.setdefault("finalRecommendation", {})
            summary = _safe_str(llm_rec.get("summary"))
            if summary:
                merged_rec["summary"] = summary
            next_step = _safe_str(llm_rec.get("nextStep"))
            if next_step:
                merged_rec["nextStep"] = next_step

    # ── questionEvaluations[].feedback ───────────────────────────────────────
    # Only touch if parent array already exists; never add new elements.
    existing_qe = report.get("questionEvaluations")
    llm_qe = llm_out.get("questionEvaluations")
    if isinstance(existing_qe, list) and isinstance(llm_qe, list):
        for i, orig_item in enumerate(existing_qe):
            if not isinstance(orig_item, dict):
                continue
            if i >= len(llm_qe) or not isinstance(llm_qe[i], dict):
                continue
            feedback = _safe_str(llm_qe[i].get("feedback"))
            if feedback:
                merged["questionEvaluations"][i]["feedback"] = feedback

    # ── communicationAnalysis.summary ────────────────────────────────────────
    if "communicationAnalysis" in report:
        llm_comm = llm_out.get("communicationAnalysis")
        if isinstance(llm_comm, dict):
            summary = _safe_str(llm_comm.get("summary"))
            if summary:
                merged["communicationAnalysis"]["summary"] = summary

    # ── visionIntegrityReport.summary ────────────────────────────────────────
    if "visionIntegrityReport" in report:
        llm_vir = llm_out.get("visionIntegrityReport")
        if isinstance(llm_vir, dict):
            summary = _safe_str(llm_vir.get("summary"))
            if summary:
                merged["visionIntegrityReport"]["summary"] = summary

    # ── aiInterviewerNotes prose ─────────────────────────────────────────────
    if "aiInterviewerNotes" in report:
        llm_notes = llm_out.get("aiInterviewerNotes")
        if isinstance(llm_notes, dict):
            merged_notes = merged.setdefault("aiInterviewerNotes", {})
            summary = _safe_str(llm_notes.get("summary"))
            if summary:
                merged_notes["summary"] = summary
            strengths = _safe_str_list(llm_notes.get("strengths"))
            if strengths:
                merged_notes["strengths"] = strengths
            weaknesses = _safe_str_list(llm_notes.get("weaknesses"))
            if weaknesses:
                merged_notes["weaknesses"] = weaknesses
            rfuq = _safe_str_list(llm_notes.get("recommendedFollowUpQuestions"))
            if rfuq:
                merged_notes["recommendedFollowUpQuestions"] = rfuq

    # ── Defense-in-depth: re-pin ALL forbidden / deterministic fields ─────────
    _repin_deterministic(merged, report)

    return merged


def _repin_deterministic(merged: dict, original: dict) -> None:
    """Overwrite any deterministic field in ``merged`` with the original value.

    This is the last line of defense: even if the whitelist merge accidentally
    touched a forbidden field, this function restores it.
    """
    # Scalar forbidden keys
    for key in _FORBIDDEN_SCALAR_KEYS:
        if key in original:
            merged[key] = original[key]
        elif key in merged:
            del merged[key]

    # technicalEvaluation.score — always re-pin
    orig_tech = original.get("technicalEvaluation") or {}
    if "score" in orig_tech:
        merged.setdefault("technicalEvaluation", {})["score"] = orig_tech["score"]

    # visionMonitoring — fully re-pin (event counts, riskLevel, etc.)
    if "visionMonitoring" in original:
        merged["visionMonitoring"] = copy.deepcopy(original["visionMonitoring"])

    # visionIntegrityReport — re-pin everything except .summary
    if "visionIntegrityReport" in original:
        orig_vir = original["visionIntegrityReport"]
        merged_vir = merged.get("visionIntegrityReport") or {}
        restored = copy.deepcopy(orig_vir)
        # Preserve polished .summary if it was set above
        if isinstance(merged_vir.get("summary"), str) and merged_vir["summary"].strip():
            restored["summary"] = merged_vir["summary"]
        merged["visionIntegrityReport"] = restored

    # integrityAlerts — always re-pin (never LLM-editable)
    if "integrityAlerts" in original:
        merged["integrityAlerts"] = copy.deepcopy(original["integrityAlerts"])

    # audioAnalysis — always re-pin
    if "audioAnalysis" in original:
        merged["audioAnalysis"] = copy.deepcopy(original["audioAnalysis"])

    # finalRecommendation.status & overallScore if object schema
    if isinstance(original.get("finalRecommendation"), dict):
        orig_rec = original["finalRecommendation"]
        merged_rec = merged.get("finalRecommendation") or {}
        for pin_key in ("status", "overallScore", "score", "riskLevel"):
            if pin_key in orig_rec:
                merged_rec[pin_key] = orig_rec[pin_key]
        merged["finalRecommendation"] = merged_rec

    # scoreBreakdown — always re-pin
    if "scoreBreakdown" in original:
        merged["scoreBreakdown"] = copy.deepcopy(original["scoreBreakdown"])
