"""Pydantic schemas for the recruiter-only behavioral timeline overlay.

Advisory-only. Never used for scoring, decisioning, or final reports.
"""
from __future__ import annotations

from typing import Any, Literal, Optional

from pydantic import BaseModel, Field


class FaceBox(BaseModel):
    x: int
    y: int
    w: int
    h: int


class BehavioralTimelineEvent(BaseModel):
    timestamp: float = Field(..., description="Start time in video, seconds.")
    duration: float = Field(..., description="Event duration, seconds.")
    label: str = Field(..., description="Safe advisory label, never raw emotion.")
    confidence: float = Field(..., ge=0.0, le=1.0)
    explanation: str = ""
    raw_scores: dict[str, float] = Field(default_factory=dict)
    face_box: Optional[FaceBox] = None
    frame_width: int = 0
    frame_height: int = 0


HeatmapLevel = Literal["low", "medium", "high"]


class HeatmapBin(BaseModel):
    start: float
    end: float
    intensity: float = Field(..., ge=0.0, le=1.0)
    level: HeatmapLevel


class BehavioralTimelineSummary(BaseModel):
    dominantSignal: str = "Neutral Behavioral Signal"
    variationMoments: int = 0
    videoDuration: float = 0.0
    analyzedAt: Optional[str] = None


class BehavioralTimelineResponse(BaseModel):
    ok: bool = True
    interview_id: str
    events: list[BehavioralTimelineEvent] = Field(default_factory=list)
    heatmap: list[HeatmapBin] = Field(default_factory=list)
    summary: BehavioralTimelineSummary = Field(default_factory=BehavioralTimelineSummary)
    advisoryOnly: bool = True


class BehavioralTimelineFallback(BaseModel):
    ok: bool = False
    fallback: bool = True
    message: str = "Behavioral overlay unavailable"
    interview_id: str
    advisoryOnly: bool = True
    details: dict[str, Any] = Field(default_factory=dict)
