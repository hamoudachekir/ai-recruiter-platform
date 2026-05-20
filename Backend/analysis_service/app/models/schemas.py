from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field


class AnalyzeVideoRequest(BaseModel):
    force: bool = False


class SaveFinalReportRequest(BaseModel):
    report: dict[str, Any]


class VisionEvent(BaseModel):
    timestamp: datetime = Field(default_factory=datetime.utcnow)
    timeInVideoSeconds: int
    questionId: str = ""
    type: str
    severity: str
    message: str
    source: str = "post_interview_video_analysis"
    meta: dict[str, Any] = Field(default_factory=dict)


class FeedbackRequest(BaseModel):
    """Recruiter feedback payload for ML dataset construction.

    Fields:
        humanScore:     Recruiter's corrected score (0–100).
        humanDecision:  Recruiter's decision label.
        comment:        Optional free-text explanation.
        overrideReason: Why the system's decision was overridden.
        candidateId:    Optional candidate identifier for linkage.
    """

    humanScore: float = Field(..., ge=0, le=100)
    humanDecision: str = Field(..., pattern="^(PASS|FAIL|REVIEW_REQUIRED)$")
    comment: str = ""
    overrideReason: str = ""
    candidateId: str = ""
