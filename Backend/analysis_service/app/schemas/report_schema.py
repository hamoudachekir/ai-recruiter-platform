"""Pydantic schema for the post-interview final report.

This schema validates the final report shape before persistence to MongoDB.
It is strict enough to catch malformed reports but flexible enough to maintain
backward compatibility with existing documents.

Design principles:
- Numeric fields are strictly typed (int/float) to prevent corruption.
- Optional fields allow existing documents that may not include every field.
- extra="allow" ensures backward compatibility with legacy fields.
- Lists default to empty lists where appropriate to simplify client code.
"""

from datetime import datetime
from typing import Any, Dict, List, Optional, Union

from pydantic import BaseModel, Field, validator


class CandidateInfo(BaseModel):
    """Candidate identification information."""

    name: Optional[str] = None
    email: Optional[str] = None
    candidateId: Optional[str] = None

    class Config:
        extra = "allow"


class InterviewMetadata(BaseModel):
    """Interview session metadata."""

    interviewId: Optional[str] = None
    jobTitle: Optional[str] = None
    jobId: Optional[str] = None
    duration: Optional[str] = None  # Human-readable duration string
    durationSeconds: Optional[float] = None  # Numeric duration for calculations
    generatedAt: Optional[datetime] = None
    createdAt: Optional[datetime] = None
    updatedAt: Optional[datetime] = None

    class Config:
        extra = "allow"


class TechnicalEvaluation(BaseModel):
    """Technical assessment block."""

    score: Optional[int] = Field(None, ge=0, le=100)
    summary: Optional[str] = None
    strengths: List[str] = Field(default_factory=list)
    weaknesses: List[str] = Field(default_factory=list)
    technicalInsights: Optional[str] = None

    class Config:
        extra = "allow"


class HREvaluation(BaseModel):
    """HR/soft skills assessment block."""

    score: Optional[int] = Field(None, ge=0, le=100)
    summary: Optional[str] = None
    strengths: List[str] = Field(default_factory=list)
    weaknesses: List[str] = Field(default_factory=list)
    hrInsights: Optional[str] = None
    communicationAnalysis: Optional[Dict[str, Any]] = None

    class Config:
        extra = "allow"


class VisionMetrics(BaseModel):
    """Computer vision analysis metrics."""

    faceVisibilityRate: Optional[str] = None  # e.g., "81.5%"
    faceVisiblePercent: Optional[float] = Field(None, ge=0, le=100)
    multipleFacesDetected: Optional[bool] = None
    absenceEvents: Optional[int] = Field(None, ge=0)
    lightingIssues: Optional[int] = Field(None, ge=0)
    positionIssues: Optional[int] = Field(None, ge=0)
    cameraQuality: Optional[str] = None  # "Good", "Acceptable", "Needs Review"
    totalChecks: Optional[int] = Field(None, ge=0)
    faceDetectedChecks: Optional[int] = Field(None, ge=0)

    # Live monitoring specific fields
    tabSwitchEvents: Optional[int] = Field(None, ge=0)
    fullscreenExitEvents: Optional[int] = Field(None, ge=0)

    class Config:
        extra = "allow"


class AudioMetrics(BaseModel):
    """Audio analysis metrics."""

    transcriptionAvailable: Optional[bool] = None
    longSilenceEvents: Optional[int] = Field(None, ge=0)
    silenceEvents: Optional[int] = Field(None, ge=0)
    longSilenceSeconds: Optional[float] = Field(None, ge=0)
    speakerChangeDetected: Optional[bool] = None
    audioQuality: Optional[str] = None

    class Config:
        extra = "allow"


class IntegrityAlert(BaseModel):
    """Single integrity alert/event."""

    type: Optional[str] = None
    severity: Optional[str] = None  # "low", "medium", "high"
    duration: Optional[str] = None  # Human-readable duration
    durationMs: Optional[int] = None  # Numeric duration
    questionId: Optional[str] = None
    message: Optional[str] = None
    source: Optional[str] = None
    timestamp: Optional[datetime] = None

    class Config:
        extra = "allow"


class IntegrityMetrics(BaseModel):
    """Integrity and compliance monitoring metrics."""

    alerts: List[IntegrityAlert] = Field(default_factory=list)
    totalAlerts: Optional[int] = Field(None, ge=0)
    highSeverityCount: Optional[int] = Field(None, ge=0)
    mediumSeverityCount: Optional[int] = Field(None, ge=0)
    lowSeverityCount: Optional[int] = Field(None, ge=0)
    humanReviewRequired: Optional[bool] = None
    summary: Optional[str] = None

    class Config:
        extra = "allow"


class TranscriptInfo(BaseModel):
    """Transcript and speech-to-text information."""

    available: Optional[bool] = None
    fullText: Optional[str] = None
    summary: Optional[str] = None
    transcriptSummary: Optional[str] = None
    language: Optional[str] = None
    segments: List[Dict[str, Any]] = Field(default_factory=list)
    wordCount: Optional[int] = Field(None, ge=0)

    class Config:
        extra = "allow"


class ScoreBreakdown(BaseModel):
    """Detailed score breakdown by category."""

    technicalScore: Optional[int] = Field(None, ge=0, le=100)
    hrScore: Optional[int] = Field(None, ge=0, le=100)
    integrityScore: Optional[int] = Field(None, ge=0, le=100)
    totalScore: Optional[int] = Field(None, ge=0, le=100)
    cameraScore: Optional[int] = Field(None, ge=0, le=100)
    audioScore: Optional[int] = Field(None, ge=0, le=100)
    quizScore: Optional[float] = Field(None, ge=0, le=100)
    cvJobMatchScore: Optional[float] = Field(None, ge=0, le=100)

    class Config:
        extra = "allow"


class ReportQuality(BaseModel):
    """Reliability and completeness indicators for recruiter decision support."""

    confidence: Optional[str] = None
    isReliableForDecision: Optional[bool] = None
    reasons: List[str] = Field(default_factory=list)
    missingData: List[str] = Field(default_factory=list)
    warnings: List[str] = Field(default_factory=list)

    class Config:
        extra = "allow"


class RecruiterDecisionSummary(BaseModel):
    """Recruiter-facing decision support summary derived from deterministic data."""

    decision: Optional[str] = None  # "proceed", "manual_review", "insufficient_data"
    label: Optional[str] = None  # Display label like "Manual Review Required"
    confidence: Optional[str] = None  # "low", "medium", "high"
    riskLevel: Optional[str] = None  # "low", "medium", "high"
    oneSentenceSummary: Optional[str] = None  # Quick summary for recruiters
    whyThisDecision: List[str] = Field(default_factory=list)  # Reasons for the decision
    topWarnings: List[str] = Field(default_factory=list)  # Critical warnings
    shortReason: Optional[str] = None
    recruiterAction: Optional[str] = None
    keyFindings: List[str] = Field(default_factory=list)
    blockers: List[str] = Field(default_factory=list)
    nextSteps: List[str] = Field(default_factory=list)

    class Config:
        extra = "allow"


class EvidenceSummary(BaseModel):
    """Summary of evidence captured during the interview."""

    usableTranscript: Optional[bool] = None
    sttProcessCompleted: Optional[bool] = None
    speechSegments: Optional[int] = None
    transcriptWords: Optional[int] = None
    candidateAnswersDetected: Optional[bool] = None
    technicalEvidenceAvailable: Optional[bool] = None
    hrEvidenceAvailable: Optional[bool] = None
    evidenceLevel: Optional[str] = None  # "none", "limited", "sufficient"

    class Config:
        extra = "allow"


class TrustMetrics(BaseModel):
    """Trust/integrity metrics."""

    faceVisibilityPercent: Optional[float] = None
    absenceEvents: Optional[int] = None
    multipleFacesDetected: Optional[bool] = None
    longSilenceEvents: Optional[int] = None
    longSilenceSeconds: Optional[float] = None
    totalAlerts: Optional[int] = None

    class Config:
        extra = "allow"


class TrustSummary(BaseModel):
    """Simplified trust/integrity summary for recruiters."""

    status: Optional[str] = None  # "passed", "needs_review", "failed"
    label: Optional[str] = None  # Display label
    reasons: List[str] = Field(default_factory=list)
    metrics: Optional[TrustMetrics] = None

    class Config:
        extra = "allow"


class JobFitAnalysis(BaseModel):
    """Job fit assessment for recruiters."""

    fitLevel: Optional[str] = None  # "strong", "moderate", "weak", "unknown"
    confidence: Optional[str] = None  # "low", "medium", "high"
    matchedSkills: List[str] = Field(default_factory=list)
    missingOrUnverifiedSkills: List[str] = Field(default_factory=list)
    summary: Optional[str] = None
    followUpQuestions: List[str] = Field(default_factory=list)

    class Config:
        extra = "allow"


class FinalRecommendation(BaseModel):
    """Final hiring recommendation."""

    status: Optional[str] = None  # e.g., "RECOMMENDED", "NEEDS_REVIEW", etc.
    text: Optional[str] = None  # Human-readable recommendation
    summary: Optional[str] = None
    nextStep: Optional[str] = None
    recruiterNotes: Optional[str] = None

    class Config:
        extra = "allow"


class PolishMetadata(BaseModel):
    """Metadata about LLM polish step."""

    enabled: Optional[bool] = None
    success: Optional[bool] = None
    provider: Optional[str] = None
    model: Optional[str] = None
    nonDestructive: Optional[bool] = None
    fallbackUsed: Optional[bool] = None  # Whether a fallback provider was used
    userFriendlyMessage: Optional[str] = None  # Message for main UI
    debugError: Optional[str] = None  # Full error for debug/system view
    error: Optional[str] = None  # Legacy error field
    timestamp: Optional[datetime] = None

    class Config:
        extra = "allow"


class FinalReport(BaseModel):
    """Complete final interview report.

    This is the top-level schema that validates the entire report structure
    before persistence to MongoDB.
    """

    # Identity fields
    interviewId: Optional[str] = None
    candidateName: Optional[str] = None
    jobTitle: Optional[str] = None

    # Metadata
    duration: Optional[str] = None
    durationSeconds: Optional[float] = Field(None, ge=0)
    generatedAt: Optional[datetime] = None
    createdAt: Optional[datetime] = None
    updatedAt: Optional[datetime] = None

    # Transcript
    transcriptionAvailable: Optional[bool] = None
    transcriptSummary: Optional[str] = None
    transcript: Optional[TranscriptInfo] = None

    # Evaluations
    technicalEvaluation: Optional[TechnicalEvaluation] = None
    hrEvaluation: Optional[HREvaluation] = None

    # Metrics
    visionMonitoring: Optional[VisionMetrics] = None
    vision: Optional[VisionMetrics] = None  # Alias for compatibility
    visionIntegrityReport: Optional[Dict[str, Any]] = None
    audioAnalysis: Optional[AudioMetrics] = None
    audio: Optional[AudioMetrics] = None  # Alias for compatibility
    integrityAlerts: Optional[List[IntegrityAlert]] = None
    integrity: Optional[IntegrityMetrics] = None

    # Scores and recommendations
    overallScore: Optional[int] = Field(None, ge=0, le=100)
    scoreBreakdown: Optional[ScoreBreakdown] = None
    finalRecommendation: Optional[Union[str, Dict[str, Any]]] = None
    recommendation: Optional[str] = None
    recommendationText: Optional[str] = None
    humanReviewRequired: Optional[bool] = None
    integrityScore: Optional[int] = Field(None, ge=0, le=100)
    reportQuality: Optional[ReportQuality] = None
    recruiterDecisionSummary: Optional[RecruiterDecisionSummary] = None
    evidence: List[Dict[str, Any]] = Field(default_factory=list)

    # New recruiter-first sections
    evidenceSummary: Optional[EvidenceSummary] = None
    trustSummary: Optional[TrustSummary] = None
    jobFitAnalysis: Optional[JobFitAnalysis] = None
    jobMetadataStatus: Optional[str] = None  # "linked", "missing"

    # Ethics and compliance
    ethicsNote: Optional[str] = None
    recruiterDecision: Optional[str] = None

    # Polish metadata
    polish: Optional[PolishMetadata] = None

    # Backward compatibility fields
    candidateInfo: Optional[CandidateInfo] = None
    interviewMetadata: Optional[InterviewMetadata] = None

    # Allow any additional fields for backward compatibility
    class Config:
        extra = "allow"

    @validator("integrityAlerts", pre=True)
    def ensure_list(cls, v):
        """Ensure integrityAlerts is always a list."""
        if v is None:
            return []
        if isinstance(v, list):
            return v
        return [v]


def validate_final_report(report: dict) -> dict:
    """Validate a report dictionary against the FinalReport schema.

    Args:
        report: The report dictionary to validate.

    Returns:
        The validated report as a dictionary (with defaults applied).

    Raises:
        ValueError: If the report fails validation with a structured error message.
    """
    try:
        validated = FinalReport(**report)
        # exclude_none=True: only write fields that have actual values.
        # This prevents $set from overwriting existing non-null MongoDB fields
        # with Python None (→ BSON null) on retries or incremental updates.
        return validated.dict(exclude_none=True)
    except Exception as exc:
        # Extract specific field errors for better debugging
        error_details = []
        if hasattr(exc, "errors"):
            for error in exc.errors():
                loc = ".".join(str(x) for x in error.get("loc", []))
                msg = error.get("msg", "Unknown error")
                error_details.append(f"{loc}: {msg}")

        error_msg = f"Report validation failed: {exc}"
        if error_details:
            error_msg += f" | Details: {'; '.join(error_details)}"
        raise ValueError(error_msg) from exc
