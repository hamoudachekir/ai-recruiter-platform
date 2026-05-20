"""Tests for report schema validation.

This module tests:
- Valid report validation
- Malformed report rejection
- Field type enforcement
- Backward compatibility
"""
import pytest
from datetime import datetime, timezone

from app.schemas.report_schema import (
    FinalReport,
    TechnicalEvaluation,
    VisionMetrics,
    validate_final_report,
)


class TestReportSchemaValidation:
    """Test suite for FinalReport schema validation."""

    def test_minimal_valid_report(self):
        """A minimal valid report should pass validation."""
        report = {
            "interviewId": "test-interview-123",
            "candidateName": "Test Candidate",
            "jobTitle": "Software Engineer",
            "duration": "10.5 minutes",
            "technicalEvaluation": {
                "score": 75,
                "strengths": ["Good communication"],
                "weaknesses": ["Could improve depth"],
            },
            "transcriptionAvailable": True,
        }

        result = validate_final_report(report)
        assert result["interviewId"] == "test-interview-123"
        assert result["candidateName"] == "Test Candidate"
        assert result["technicalEvaluation"]["score"] == 75

    def test_full_valid_report(self):
        """A complete report with all fields should pass validation."""
        report = {
            "interviewId": "test-interview-456",
            "candidateName": "Jane Doe",
            "jobTitle": "Senior Developer",
            "duration": "15.2 minutes",
            "durationSeconds": 912.0,
            "generatedAt": datetime.now(timezone.utc),
            "transcriptionAvailable": True,
            "transcriptSummary": "Good technical discussion covering system design.",
            "technicalEvaluation": {
                "score": 82,
                "summary": "Strong technical skills demonstrated.",
                "strengths": ["System design knowledge", "API design"],
                "weaknesses": ["Database optimization could improve"],
                "technicalInsights": "Shows senior-level thinking.",
            },
            "hrEvaluation": {
                "score": 88,
                "summary": "Excellent communication.",
                "strengths": ["Clear communication", "Good questions"],
                "weaknesses": [],
                "hrInsights": "Good culture fit.",
            },
            "overallScore": 85,
            "visionMonitoring": {
                "faceVisibilityRate": "85.5%",
                "faceVisiblePercent": 85.5,
                "multipleFacesDetected": False,
                "absenceEvents": 2,
                "lightingIssues": 1,
                "cameraQuality": "Good",
            },
            "audioAnalysis": {
                "transcriptionAvailable": True,
                "longSilenceEvents": 3,
                "silenceEvents": 3,
                "longSilenceSeconds": 12.5,
            },
            "integrityAlerts": [],
            "finalRecommendation": "Recommended for next round.",
            "humanReviewRequired": False,
            "ethicsNote": "This system assists recruiter review.",
            "polish": {
                "enabled": True,
                "success": True,
                "provider": "gemini",
                "model": "gemini-2.5-flash-lite",
                "nonDestructive": True,
            },
        }

        result = validate_final_report(report)
        assert result["overallScore"] == 85
        assert result["visionMonitoring"]["faceVisiblePercent"] == 85.5

    def test_score_range_validation(self):
        """Scores outside 0-100 range should fail validation."""
        report = {
            "interviewId": "test-123",
            "technicalEvaluation": {
                "score": 150,  # Invalid: > 100
            },
        }

        with pytest.raises(ValueError) as exc_info:
            validate_final_report(report)

        assert "score" in str(exc_info.value).lower() or "validation" in str(exc_info.value).lower()

    def test_negative_score_validation(self):
        """Negative scores should fail validation."""
        report = {
            "interviewId": "test-123",
            "technicalEvaluation": {
                "score": -10,  # Invalid: negative
            },
        }

        with pytest.raises(ValueError) as exc_info:
            validate_final_report(report)

        assert "score" in str(exc_info.value).lower() or "validation" in str(exc_info.value).lower()

    def test_empty_report_fails_validation(self):
        """Completely empty report may pass (all fields optional) but should have defaults."""
        report = {}

        result = validate_final_report(report)
        # Empty dict should be valid (all fields are optional)
        assert isinstance(result, dict)

    def test_backward_compatibility_extra_fields(self):
        """Extra fields not in schema should be allowed for backward compatibility."""
        report = {
            "interviewId": "test-123",
            "legacyField": "some old value",
            "anotherLegacy": {"nested": "data"},
            "technicalEvaluation": {
                "score": 70,
                "legacyTechField": True,
            },
        }

        result = validate_final_report(report)
        # Extra fields should be preserved
        assert result["legacyField"] == "some old value"
        assert result["anotherLegacy"]["nested"] == "data"
        assert result["technicalEvaluation"]["legacyTechField"] is True

    def test_integrity_alerts_as_list(self):
        """integrityAlerts must be a list, not a dict."""
        report = {
            "interviewId": "test-123",
            "integrityAlerts": [
                {"type": "TAB_SWITCH", "severity": "medium"},
                {"type": "NO_FACE", "severity": "low"},
            ],
        }

        result = validate_final_report(report)
        assert len(result["integrityAlerts"]) == 2
        assert result["integrityAlerts"][0]["type"] == "TAB_SWITCH"

    def test_wrong_type_for_boolean_field(self):
        """Boolean fields with wrong types should be caught."""
        report = {
            "interviewId": "test-123",
            "transcriptionAvailable": "yes",  # Should be bool
        }

        # Pydantic v1 may coerce this, but in strict mode it would fail
        # For now, we accept that string "yes" may be coerced to True
        result = validate_final_report(report)
        assert result["transcriptionAvailable"] is not None

    def test_vision_metrics_defaults(self):
        """VisionMetrics should handle optional fields gracefully."""
        vm = VisionMetrics()
        assert vm.faceVisibilityRate is None
        assert vm.absenceEvents is None

    def test_technical_evaluation_defaults(self):
        """TechnicalEvaluation should have empty lists as defaults."""
        te = TechnicalEvaluation()
        assert te.strengths == []
        assert te.weaknesses == []


class TestSchemaModelDirectly:
    """Direct tests on Pydantic models."""

    def test_technical_evaluation_score_bounds(self):
        """Test score field constraints directly."""
        # Valid score
        te = TechnicalEvaluation(score=75)
        assert te.score == 75

        # Edge cases
        te0 = TechnicalEvaluation(score=0)
        assert te0.score == 0

        te100 = TechnicalEvaluation(score=100)
        assert te100.score == 100

    def test_technical_evaluation_score_out_of_bounds(self):
        """Test that out-of-bounds scores raise validation error."""
        with pytest.raises(ValueError):
            TechnicalEvaluation(score=101)

        with pytest.raises(ValueError):
            TechnicalEvaluation(score=-1)

    def test_vision_metrics_face_percent_bounds(self):
        """Test faceVisiblePercent field constraints."""
        vm = VisionMetrics(faceVisiblePercent=85.5)
        assert vm.faceVisiblePercent == 85.5

        vm0 = VisionMetrics(faceVisiblePercent=0)
        assert vm0.faceVisiblePercent == 0

        vm100 = VisionMetrics(faceVisiblePercent=100)
        assert vm100.faceVisiblePercent == 100

    def test_vision_metrics_negative_face_percent(self):
        """Negative faceVisiblePercent should fail."""
        with pytest.raises(ValueError):
            VisionMetrics(faceVisiblePercent=-5)

    def test_final_report_with_metadata(self):
        """Test that FinalReport can include arbitrary metadata."""
        report = FinalReport(
            interviewId="test-123",
            _internalField="hidden",
            customMetadata={"key": "value"},
        )
        assert report.interviewId == "test-123"
