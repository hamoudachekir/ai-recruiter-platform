"""Tests for report polish merge functionality.

This module tests:
- Deterministic field protection (scores cannot be changed by LLM)
- Whitelist merge (only allowed text fields can be polished)
- Score preservation (deterministic scores are re-pinned)
"""
import copy
import pytest
from datetime import datetime, timezone

from app.services.report_polish import (
    _whitelist_merge,
    is_allowed_polish_path,
    _is_protected_numeric_path,
    _get_nested_value,
    _set_nested_value,
    _FORBIDDEN_SCALAR_KEYS,
    _ALLOWED_POLISH_PATHS,
    _PROTECTED_NUMERIC_PATHS,
)


class TestIsAllowedPolishPath:
    """Test the is_allowed_polish_path helper function."""

    def test_allowed_top_level_paths(self):
        """Top-level allowed paths should return True."""
        assert is_allowed_polish_path("transcriptSummary") is True
        assert is_allowed_polish_path("recommendationText") is True
        assert is_allowed_polish_path("summary") is True
        assert is_allowed_polish_path("recruiterNotes") is True

    def test_allowed_nested_paths(self):
        """Nested allowed paths should return True."""
        assert is_allowed_polish_path("technicalEvaluation.strengths") is True
        assert is_allowed_polish_path("technicalEvaluation.weaknesses") is True
        assert is_allowed_polish_path("hrEvaluation.strengths") is True
        assert is_allowed_polish_path("hrEvaluation.weaknesses") is True

    def test_forbidden_paths(self):
        """Forbidden paths should return False."""
        assert is_allowed_polish_path("technicalEvaluation.score") is False
        assert is_allowed_polish_path("interviewId") is False
        assert is_allowed_polish_path("overallScore") is False
        assert is_allowed_polish_path("durationSeconds") is False

    def test_question_evaluations_path(self):
        """Question evaluations array should be allowed."""
        assert is_allowed_polish_path("questionEvaluations") is True
        assert is_allowed_polish_path("questionEvaluations.0.feedback") is True
        assert is_allowed_polish_path("questionEvaluations[0].feedback") is True


class TestIsProtectedNumericPath:
    """Test the _is_protected_numeric_path helper function."""

    def test_protected_score_paths(self):
        """Score paths should be protected."""
        assert _is_protected_numeric_path("technicalEvaluation.score") is True
        assert _is_protected_numeric_path("hrEvaluation.score") is True

    def test_protected_vision_paths(self):
        """Vision numeric paths should be protected."""
        assert _is_protected_numeric_path("visionMonitoring.absenceEvents") is True
        assert _is_protected_numeric_path("visionMonitoring.faceVisiblePercent") is True
        assert _is_protected_numeric_path("visionMonitoring.lightingIssues") is True

    def test_protected_audio_paths(self):
        """Audio numeric paths should be protected."""
        assert _is_protected_numeric_path("audioAnalysis.longSilenceEvents") is True
        assert _is_protected_numeric_path("audioAnalysis.transcriptionAvailable") is True

    def test_unprotected_paths(self):
        """Text paths should not be protected."""
        assert _is_protected_numeric_path("transcriptSummary") is False
        assert _is_protected_numeric_path("technicalEvaluation.strengths") is False


class TestNestedValueHelpers:
    """Test the nested value getter and setter helpers."""

    def test_get_nested_value_exists(self):
        """Should return value for existing nested path."""
        data = {"a": {"b": {"c": "value"}}}
        assert _get_nested_value(data, "a.b.c") == "value"
        assert _get_nested_value(data, "a.b") == {"c": "value"}

    def test_get_nested_value_missing(self):
        """Should return None for non-existent path."""
        data = {"a": {"b": "value"}}
        assert _get_nested_value(data, "a.x.c") is None
        assert _get_nested_value(data, "nonexistent.path") is None

    def test_set_nested_value(self):
        """Should set value at nested path."""
        data = {}
        _set_nested_value(data, "a.b.c", "value")
        assert data["a"]["b"]["c"] == "value"

    def test_set_nested_value_existing(self):
        """Should overwrite existing value."""
        data = {"a": {"b": "old"}}
        _set_nested_value(data, "a.b", "new")
        assert data["a"]["b"] == "new"


class TestWhitelistMerge:
    """Test the _whitelist_merge function."""

    def test_score_unchanged_by_llm(self):
        """Technical score should remain unchanged even if LLM tries to modify it."""
        deterministic = {
            "interviewId": "test-123",
            "technicalEvaluation": {
                "score": 70,
                "strengths": ["Original strength"],
                "weaknesses": ["Original weakness"],
            },
        }

        # LLM tries to increase the score to 95
        llm_out = {
            "technicalEvaluation": {
                "score": 95,  # Attempted change
                "strengths": ["Polished strength"],  # Allowed change
            },
        }

        merged = _whitelist_merge(deterministic, llm_out)

        # Score must remain 70 (deterministic value)
        assert merged["technicalEvaluation"]["score"] == 70
        # Strengths can be polished
        assert merged["technicalEvaluation"]["strengths"] == ["Polished strength"]

    def test_overall_score_protected(self):
        """Overall score should be protected from LLM changes."""
        deterministic = {
            "interviewId": "test-123",
            "overallScore": 75,
        }

        llm_out = {
            "overallScore": 95,  # LLM tries to change
        }

        merged = _whitelist_merge(deterministic, llm_out)

        # overallScore must remain unchanged
        assert merged["overallScore"] == 75

    def test_transcript_summary_can_be_polished(self):
        """transcriptSummary is text and should be polishable."""
        deterministic = {
            "interviewId": "test-123",
            "transcriptSummary": "Original summary text.",
        }

        llm_out = {
            "transcriptSummary": "Improved, polished summary text.",
        }

        merged = _whitelist_merge(deterministic, llm_out)

        assert merged["transcriptSummary"] == "Improved, polished summary text."

    def test_vision_metrics_protected(self):
        """Vision monitoring numeric metrics should be protected."""
        deterministic = {
            "interviewId": "test-123",
            "visionMonitoring": {
                "faceVisibilityRate": "75.5%",
                "faceVisiblePercent": 75.5,
                "absenceEvents": 5,
                "multipleFacesDetected": False,
            },
        }

        llm_out = {
            "visionMonitoring": {
                "faceVisiblePercent": 95.0,  # LLM tries to improve
                "absenceEvents": 0,  # LLM tries to hide
                "multipleFacesDetected": True,  # LLM tries to change
            },
        }

        merged = _whitelist_merge(deterministic, llm_out)

        # All vision metrics must remain unchanged
        assert merged["visionMonitoring"]["faceVisiblePercent"] == 75.5
        assert merged["visionMonitoring"]["absenceEvents"] == 5
        assert merged["visionMonitoring"]["multipleFacesDetected"] is False

    def test_audio_metrics_protected(self):
        """Audio analysis metrics should be protected."""
        deterministic = {
            "interviewId": "test-123",
            "audioAnalysis": {
                "transcriptionAvailable": True,
                "longSilenceEvents": 3,
                "longSilenceSeconds": 15.5,
            },
        }

        llm_out = {
            "audioAnalysis": {
                "transcriptionAvailable": False,  # LLM tries to hide
                "longSilenceEvents": 0,  # LLM tries to hide
                "longSilenceSeconds": 0.0,
            },
        }

        merged = _whitelist_merge(deterministic, llm_out)

        # Audio metrics must remain unchanged
        assert merged["audioAnalysis"]["transcriptionAvailable"] is True
        assert merged["audioAnalysis"]["longSilenceEvents"] == 3
        assert merged["audioAnalysis"]["longSilenceSeconds"] == 15.5

    def test_forbidden_scalar_keys_preserved(self):
        """All forbidden scalar keys should be preserved from deterministic report."""
        deterministic = {
            "interviewId": "test-123",
            "candidateName": "Original Name",
            "jobTitle": "Original Title",
            "duration": "10.5 minutes",
            "humanReviewRequired": True,
            "ethicsNote": "Original ethics note.",
        }

        llm_out = {
            "interviewId": "changed-123",  # Should be protected
            "candidateName": "Changed Name",  # Should be protected
            "jobTitle": "Changed Title",  # Should be protected
            "duration": "5 minutes",  # Should be protected
            "humanReviewRequired": False,  # Should be protected
            "ethicsNote": "Changed note.",  # Should be protected
        }

        merged = _whitelist_merge(deterministic, llm_out)

        for key in _FORBIDDEN_SCALAR_KEYS:
            if key in deterministic:
                assert merged[key] == deterministic[key], f"Key {key} was modified"

    def test_empty_llm_output(self):
        """Empty LLM output should return deterministic report unchanged."""
        deterministic = {
            "interviewId": "test-123",
            "technicalEvaluation": {
                "score": 70,
                "strengths": ["Original"],
            },
        }

        llm_out = {}

        merged = _whitelist_merge(deterministic, llm_out)

        assert merged["technicalEvaluation"]["score"] == 70
        assert merged["technicalEvaluation"]["strengths"] == ["Original"]

    def test_polish_metadata_never_overwritten(self):
        """Polish metadata field should never be overwritten by LLM."""
        deterministic = {
            "interviewId": "test-123",
            "polish": {
                "enabled": True,
                "success": True,
                "provider": "original",
            },
        }

        llm_out = {
            "polish": {
                "enabled": False,  # LLM tries to disable
                "success": False,
                "provider": "hacked",
            },
        }

        merged = _whitelist_merge(deterministic, llm_out)

        # Polish metadata must remain unchanged
        assert merged["polish"]["enabled"] is True
        assert merged["polish"]["success"] is True
        assert merged["polish"]["provider"] == "original"

    def test_question_evaluations_feedback_polished(self):
        """Question evaluation feedback can be polished if parent exists."""
        deterministic = {
            "interviewId": "test-123",
            "questionEvaluations": [
                {"question": "Q1", "feedback": "Original feedback"},
                {"question": "Q2", "feedback": "Another feedback"},
            ],
        }

        llm_out = {
            "questionEvaluations": [
                {"question": "Q1", "feedback": "Polished feedback 1"},
                {"question": "Q2", "feedback": "Polished feedback 2"},
            ],
        }

        merged = _whitelist_merge(deterministic, llm_out)

        assert merged["questionEvaluations"][0]["feedback"] == "Polished feedback 1"
        assert merged["questionEvaluations"][1]["feedback"] == "Polished feedback 2"

    def test_hr_evaluation_prose_polished(self):
        """HR evaluation prose fields can be polished."""
        deterministic = {
            "interviewId": "test-123",
            "hrEvaluation": {
                "score": 80,  # Protected
                "summary": "Original summary",
                "strengths": ["Original strength"],
                "weaknesses": ["Original weakness"],
                "hrInsights": "Original insights",
            },
        }

        llm_out = {
            "hrEvaluation": {
                "score": 95,  # Attempted change - should be ignored
                "summary": "Polished summary",
                "strengths": ["Polished strength"],
                "weaknesses": ["Polished weakness"],
                "hrInsights": "Polished insights",
            },
        }

        merged = _whitelist_merge(deterministic, llm_out)

        # Score protected
        assert merged["hrEvaluation"]["score"] == 80
        # Prose polished
        assert merged["hrEvaluation"]["summary"] == "Polished summary"
        assert merged["hrEvaluation"]["strengths"] == ["Polished strength"]
        assert merged["hrEvaluation"]["weaknesses"] == ["Polished weakness"]
        assert merged["hrEvaluation"]["hrInsights"] == "Polished insights"
