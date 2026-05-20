"""
Test new recruiter-first report fields.

Verifies:
1. recruiterDecisionSummary with oneSentenceSummary, whyThisDecision, topWarnings
2. evidenceSummary with transcript status
3. trustSummary with simplified status
4. jobFitAnalysis with skills
5. jobMetadataStatus (linked/missing)
6. polish.userFriendlyMessage and debugError
"""
import pytest
from datetime import datetime
from app.schemas.report_schema import FinalReport, RecruiterDecisionSummary, EvidenceSummary, TrustSummary, JobFitAnalysis
from app.services.report_service import build_final_report
from app.services.report_polish import polish


class TestNewReportFields:
    """Test the new recruiter-first report structure."""

    def test_recruiter_decision_summary_fields(self):
        """Test that recruiterDecisionSummary contains all new fields."""
        summary_data = {
            "decision": "manual_review",
            "label": "Manual Review Required",
            "confidence": "low",
            "riskLevel": "medium",
            "shortReason": "Transcript missing, needs review",
            "recruiterAction": "Review manually",
            "keyFindings": ["Finding 1", "Finding 2"],
            "blockers": ["No transcript"],
            # New fields
            "oneSentenceSummary": "The interview cannot be evaluated reliably because no usable transcript was extracted.",
            "whyThisDecision": [
                "No usable transcript content was extracted",
                "Multiple faces were detected during the interview",
                "Job information is not linked"
            ],
            "topWarnings": [
                "Multiple faces detected - verify candidate was alone",
                "No usable transcript - candidate responses cannot be evaluated"
            ]
        }
        
        summary = RecruiterDecisionSummary(**summary_data)
        
        assert summary.oneSentenceSummary is not None
        assert len(summary.whyThisDecision) == 3
        assert len(summary.topWarnings) == 2
        assert "transcript" in summary.oneSentenceSummary.lower()

    def test_evidence_summary_schema(self):
        """Test evidenceSummary schema validation."""
        evidence = EvidenceSummary(
            sttProcessCompleted=True,
            usableTranscript=False,
            speechSegments=0,
            transcriptWords=0,
            candidateAnswersDetected=False,
            technicalEvidenceAvailable=False,
            hrEvidenceAvailable=False,
            evidenceLevel="none",
            fallbackReason="No usable transcript content was extracted"
        )
        
        assert evidence.sttProcessCompleted is True
        assert evidence.usableTranscript is False
        assert evidence.evidenceLevel == "none"
        assert "transcript" in evidence.fallbackReason.lower()

    def test_trust_summary_schema(self):
        """Test trustSummary schema validation."""
        trust = TrustSummary(
            status="needs_review",
            label="Needs Review",
            reasons=[
                "Multiple faces were detected during the interview",
                "No usable transcript was extracted"
            ],
            metrics={
                "faceVisibilityPercent": 85.0,
                "absenceEvents": 0,
                "multipleFacesDetected": True,
                "longSilenceEvents": 2,
                "longSilenceSeconds": 5.5,
                "totalAlerts": 1
            }
        )
        
        assert trust.status == "needs_review"
        assert trust.label == "Needs Review"
        assert len(trust.reasons) == 2
        assert trust.metrics.multipleFacesDetected is True

    def test_job_fit_analysis_schema(self):
        """Test jobFitAnalysis schema validation."""
        job_fit = JobFitAnalysis(
            fitLevel="unknown",
            confidence="low",
            matchedSkills=[],
            missingOrUnverifiedSkills=[],
            summary="Job fit unavailable because no job offer is linked to this interview room.",
            followUpQuestions=["Review the transcript against job requirements manually."]
        )
        
        assert job_fit.fitLevel == "unknown"
        assert "job" in job_fit.summary.lower()
        assert "linked" in job_fit.summary.lower()

    def test_full_report_with_new_sections(self):
        """Test that FinalReport accepts all new sections."""
        report_data = {
            "interviewId": "test-interview-123",
            "candidateName": "Test Candidate",
            "candidateEmail": "test@example.com",
            "jobTitle": "Job not linked",
            "jobMetadataStatus": "missing",
            "overallScore": 65,
            "technicalScore": 70,
            "hrScore": 60,
            "integrityScore": 85,
            "durationSeconds": 300,
            "reportQuality": {
                "score": 65,
                "grade": "C",
                "confidence": "low",
                "completenessPercent": 45.0,
                "missingData": ["transcript"]
            },
            "recruiterDecisionSummary": {
                "decision": "manual_review",
                "label": "Manual Review Required",
                "confidence": "low",
                "riskLevel": "medium",
                "shortReason": "The interview cannot be evaluated",
                "recruiterAction": "Review manually",
                "keyFindings": ["No usable transcript"],
                "blockers": ["Transcript unavailable"],
                "oneSentenceSummary": "No usable transcript was extracted.",
                "whyThisDecision": ["No transcript available"],
                "topWarnings": ["Cannot evaluate candidate responses"]
            },
            "evidenceSummary": {
                "sttProcessCompleted": True,
                "usableTranscript": False,
                "speechSegments": 0,
                "transcriptWords": 0,
                "candidateAnswersDetected": False,
                "technicalEvidenceAvailable": False,
                "hrEvidenceAvailable": False,
                "evidenceLevel": "none",
                "fallbackReason": "No usable transcript"
            },
            "trustSummary": {
                "status": "needs_review",
                "label": "Needs Review",
                "reasons": ["No usable transcript"],
                "metrics": {
                    "faceVisibilityPercent": 90.0,
                    "absenceEvents": 0,
                    "multipleFacesDetected": False,
                    "longSilenceEvents": 0,
                    "longSilenceSeconds": 0.0,
                    "totalAlerts": 0
                }
            },
            "jobFitAnalysis": {
                "fitLevel": "unknown",
                "confidence": "low",
                "matchedSkills": [],
                "missingOrUnverifiedSkills": [],
                "summary": "Job not linked",
                "followUpQuestions": []
            },
            "transcript": {
                "available": False,
                "fullText": "",
                "segments": [],
                "wordCount": 0,
                "speechDurationSeconds": 0
            },
            "audioAnalysis": {
                "transcriptionAvailable": False,
                "longSilenceEvents": 0,
                "longSilenceSeconds": 0.0
            },
            "visionMonitoring": {
                "faceVisiblePercent": 90.0,
                "faceVisibilityRate": "90%",
                "absenceEvents": 0,
                "absenceTotalSeconds": 0.0,
                "multipleFacesDetected": False
            },
            "integrityAlerts": [],
            "polish": {
                "enabled": True,
                "provider": "gemini",
                "model": "gemini-1.5-flash",
                "success": False,
                "fallbackUsed": True,
                "userFriendlyMessage": "LLM polish unavailable due to temporary provider demand. Deterministic report shown.",
                "debugError": "HTTP 503 Service Unavailable from Gemini API",
                "nonDestructive": True
            },
            "generatedAt": datetime.now().isoformat(),
            "_metadata": {
                "graphVersion": "2.0"
            }
        }
        
        report = FinalReport(**report_data)
        
        # Verify all new sections exist
        assert report.recruiterDecisionSummary is not None
        assert report.recruiterDecisionSummary.oneSentenceSummary is not None
        assert report.evidenceSummary is not None
        assert report.evidenceSummary.usableTranscript is False
        assert report.trustSummary is not None
        assert report.jobFitAnalysis is not None
        assert report.jobMetadataStatus == "missing"
        
        # Verify polish metadata
        assert report.polish.success is False
        assert report.polish.userFriendlyMessage is not None
        assert "provider demand" in report.polish.userFriendlyMessage
        assert report.polish.debugError is not None
        assert "503" in report.polish.debugError

    def test_polish_schema_with_new_fields(self):
        """Test PolishMetadata schema accepts new fields."""
        from app.schemas.report_schema import PolishMetadata
        
        polish_data = {
            "enabled": True,
            "provider": "gemini",
            "model": "gemini-1.5-flash",
            "success": False,
            "fallbackUsed": True,
            "userFriendlyMessage": "LLM polish unavailable due to temporary provider demand. Deterministic report shown.",
            "debugError": "HTTP 503 Service Unavailable",
            "nonDestructive": True
        }
        
        metadata = PolishMetadata(**polish_data)
        assert metadata.fallbackUsed is True
        assert "provider demand" in metadata.userFriendlyMessage
        assert "503" in metadata.debugError


class TestReportServiceNewFields:
    """Test report_service generates new fields correctly."""

    def test_build_final_report_includes_new_sections(self):
        """Test build_final_report includes all new recruiter-first sections."""
        # Build report with empty transcript (simulating missing transcript)
        report = build_final_report(
            interview_id="test-123",
            candidate_name="John Doe",
            job_title="Job not linked",
            duration_seconds=300,
            transcript_payload={
                "transcriptionAvailable": False,
                "fullText": "",
                "segments": [],
            },
            live_vision_summary={
                "totalChecks": 100,
                "faceDetectedChecks": 90,
            },
            post_vision_summary={
                "totalChecks": 50,
                "faceDetectedChecks": 45,
            },
            live_events=[],
            post_events=[],
            silence_events=[],
            quiz_score=None,
            cv_job_match_score=None,
            job_metadata_status="missing"
        )
        
        # Verify new sections exist
        assert "evidenceSummary" in report
        assert "trustSummary" in report
        assert "jobFitAnalysis" in report
        assert "recruiterDecisionSummary" in report
        assert "jobMetadataStatus" in report
        
        # Verify evidenceSummary content (stt may have run but no usable content)
        evidence = report["evidenceSummary"]
        assert evidence["usableTranscript"] is False  # No content
        assert evidence["evidenceLevel"] == "none"
        
        # Verify trustSummary
        trust = report["trustSummary"]
        assert trust["status"] in ["passed", "needs_review", "failed"]
        assert len(trust["reasons"]) > 0
        
        # Verify jobFitAnalysis with missing job
        job_fit = report["jobFitAnalysis"]
        assert job_fit["fitLevel"] == "unknown"
        assert "linked" in job_fit["summary"].lower() or "not linked" in job_fit["summary"].lower()
        
        # Verify recruiterDecisionSummary
        decision = report["recruiterDecisionSummary"]
        assert decision["decision"] in ["manual_review", "insufficient_data"]  # No transcript
        assert decision["oneSentenceSummary"] is not None
        assert len(decision["whyThisDecision"]) > 0

    def test_build_final_report_with_transcript(self):
        """Test report generation when transcript exists."""
        # Use longer text to exceed 20 word threshold for usable transcript
        full_text = "I have five years of Python experience working on large scale systems. I have worked extensively with Django and FastAPI frameworks building REST APIs and microservices. I enjoy solving complex problems and collaborating with teams to deliver high quality software solutions."
        
        report = build_final_report(
            interview_id="test-456",
            candidate_name="Jane Smith",
            job_title="Senior Python Developer",
            duration_seconds=600,
            transcript_payload={
                "transcriptionAvailable": True,
                "fullText": full_text,
                "segments": [
                    {"start": 0, "end": 5, "text": "I have five years of Python experience working on large scale systems."},
                    {"start": 6, "end": 12, "text": "I have worked extensively with Django and FastAPI frameworks building REST APIs and microservices."},
                    {"start": 13, "end": 20, "text": "I enjoy solving complex problems and collaborating with teams to deliver high quality software solutions."}
                ],
            },
            live_vision_summary={
                "totalChecks": 200,
                "faceDetectedChecks": 190,
            },
            post_vision_summary={
                "totalChecks": 100,
                "faceDetectedChecks": 95,
            },
            live_events=[],
            post_events=[],
            silence_events=[{"start": 30, "end": 33, "duration": 3.5}],
            quiz_score=85.0,
            cv_job_match_score=None,
            job_metadata_status="linked"
        )
        
        # Verify evidenceSummary shows usable transcript
        evidence = report["evidenceSummary"]
        assert evidence["usableTranscript"] is True
        assert evidence["evidenceLevel"] in ["sufficient", "limited"]
        assert evidence["transcriptWords"] > 0
        assert evidence["speechSegments"] == 3
        assert evidence["candidateAnswersDetected"] is True
        assert evidence["technicalEvidenceAvailable"] is True
        assert evidence["hrEvidenceAvailable"] is True
        
        # Verify trustSummary
        trust = report["trustSummary"]
        assert trust["status"] in ["passed", "needs_review"]
        assert trust["metrics"]["faceVisibilityPercent"] > 90.0
        
        # Verify jobMetadataStatus
        assert report["jobMetadataStatus"] == "linked"
        
        # Verify recruiterDecisionSummary
        decision = report["recruiterDecisionSummary"]
        # With good transcript, decision should be positive
        assert decision["decision"] in ["proceed", "manual_review"]
        assert decision["oneSentenceSummary"] is not None


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
