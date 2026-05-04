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
